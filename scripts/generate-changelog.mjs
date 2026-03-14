#!/usr/bin/env node
/**
 * generate-changelog.mjs
 *
 * Generates both internal (developer-facing) and user-facing changelogs
 * from the git diff between the previous and current upstream merge.
 *
 * Internal changelog: full markdown diff summary in changelogs/internal/YYYY-MM-DD.md
 * User-facing changelog: filtered JSON in changelogs/user-facing/YYYY-MM-DD.json
 *
 * Usage:
 *   node scripts/generate-changelog.mjs [--date YYYY-MM-DD]
 *
 * Called by upstream-sync.mjs after rebase + gap scanning.
 */

import { execSync } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, unlinkSync, symlinkSync } from "node:fs";
import { join, dirname } from "node:path";

const CWD = process.cwd();

// Allow overriding date for testing
const dateFlag = process.argv.indexOf("--date");
const TODAY = dateFlag !== -1 && process.argv[dateFlag + 1]
  ? process.argv[dateFlag + 1]
  : new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Shell helpers (same pattern as upstream-sync.mjs)
// ---------------------------------------------------------------------------

function run(cmd) {
  return execSync(cmd, { cwd: CWD, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function tryRun(cmd) {
  try {
    return { ok: true, output: run(cmd) };
  } catch (e) {
    return { ok: false, output: (e.stderr || e.message || "").trim() };
  }
}

function log(msg) {
  console.log(`[generate-changelog] ${msg}`);
}

// ---------------------------------------------------------------------------
// Infrastructure filter — changes matching these are dropped from user-facing
// changelog. Based on infraKeywords from upstream-sync.mjs plus path filters.
// ---------------------------------------------------------------------------

const infraKeywords = [
  "adapterType",
  "AdapterType",
  "ADAPTER_OPTIONS",
  "adapter_type",
  "adapter",
  "modelOverride",
  "ModelSelect",
  "model selection",
  "thinkingEffort",
  "ThinkingEffort",
  "thinking effort",
  "heartbeatEnabled",
  "heartbeat",
  "runtimeConfig",
  "runtime_config",
  "runtime",
  "deploymentMode",
  "deployment",
  "provider",
  "api key",
  "api_key",
  "apiKey",
  "CLI",
  "cli",
  "self-host",
  "infrastructure",
  "docker",
  "Docker",
  "middleware",
  "provision",
];

const infraPathPatterns = [
  /^server\/src\/middleware\//,
  /^server\/src\/routes\/provision/,
  /\.env/,
  /Dockerfile/,
  /docker-compose/,
  /package\.json$/,
  /pnpm-lock\.yaml$/,
  /package-lock\.json$/,
  /\.npmrc$/,
];

function isInfraChange(commitMsg, files) {
  const msgLower = commitMsg.toLowerCase();
  // Check commit message against infra keywords
  for (const kw of infraKeywords) {
    if (msgLower.includes(kw.toLowerCase())) return true;
  }
  // Check if ALL changed files match infra path patterns
  if (files.length > 0 && files.every(f => infraPathPatterns.some(p => p.test(f)))) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Categorize commits by conventional commit prefix
// ---------------------------------------------------------------------------

function categorize(commitMsg) {
  const msg = commitMsg.trim();
  if (/^feat[(!:]/.test(msg) || /^add[(!:]/.test(msg)) return "New";
  if (/^fix[(!:]/.test(msg) || /^bugfix[(!:]/.test(msg) || /^hotfix[(!:]/.test(msg)) return "Fixed";
  if (/^improve[(!:]/.test(msg) || /^perf[(!:]/.test(msg) || /^refactor[(!:]/.test(msg) || /^enhance[(!:]/.test(msg)) return "Improved";
  if (/^docs?[(!:]/.test(msg) || /^chore[(!:]/.test(msg) || /^ci[(!:]/.test(msg) || /^build[(!:]/.test(msg) || /^test[(!:]/.test(msg)) return null; // skip docs/chore/ci/build/test
  // Default: treat as "Improved" if it doesn't match known prefixes
  return "Improved";
}

function cleanCommitMessage(msg) {
  // Strip conventional commit prefix for display
  return msg.replace(/^(feat|fix|bugfix|hotfix|improve|perf|refactor|enhance|add|docs?|chore|ci|build|test)(\(.+?\))?[!:]?\s*/i, "").trim();
}

// ---------------------------------------------------------------------------
// Get merge range
// ---------------------------------------------------------------------------

function getMergeRange() {
  // Find the two most recent merge commits (or use HEAD~20..HEAD as fallback)
  const merges = tryRun("git log --merges --format=%H -2");
  if (merges.ok && merges.output) {
    const hashes = merges.output.split("\n").filter(Boolean);
    if (hashes.length >= 2) {
      return { from: hashes[1], to: hashes[0] };
    }
    if (hashes.length === 1) {
      // Only one merge — diff from repo root to that merge
      const root = tryRun("git rev-list --max-parents=0 HEAD");
      return { from: root.ok ? root.output.split("\n")[0] : hashes[0] + "~20", to: hashes[0] };
    }
  }

  // Fallback: use last 20 commits
  const head = run("git rev-parse HEAD");
  return { from: head + "~20", to: head };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  log(`Generating changelogs for ${TODAY}`);

  const { from, to } = getMergeRange();
  log(`Diff range: ${from.slice(0, 8)}..${to.slice(0, 8)}`);

  // Get changed files (stat)
  const diffStat = tryRun(`git diff --stat ${from}..${to}`);
  const diffFiles = tryRun(`git diff --name-only ${from}..${to}`);
  const changedFiles = diffFiles.ok ? diffFiles.output.split("\n").filter(Boolean) : [];

  // Get commit log
  const commitLog = tryRun(`git log --oneline ${from}..${to}`);
  const commits = commitLog.ok
    ? commitLog.output.split("\n").filter(Boolean).map(line => {
        const spaceIdx = line.indexOf(" ");
        return {
          hash: line.slice(0, spaceIdx),
          message: line.slice(spaceIdx + 1),
        };
      })
    : [];

  if (commits.length === 0) {
    log("No commits in range. Skipping changelog generation.");
    return { generated: false };
  }

  log(`Found ${commits.length} commits, ${changedFiles.length} changed files`);

  // --- Internal changelog (developer-facing markdown) ---

  const internalDir = join(CWD, "changelogs", "internal");
  mkdirSync(internalDir, { recursive: true });

  const internalLines = [
    `# Internal Changelog — ${TODAY}`,
    "",
    `**Range:** \`${from.slice(0, 8)}..${to.slice(0, 8)}\``,
    "",
    "## Commits",
    "",
  ];

  for (const c of commits) {
    internalLines.push(`- \`${c.hash}\` ${c.message}`);
  }

  internalLines.push("", "## Changed Files", "");
  if (diffStat.ok) {
    internalLines.push("```", diffStat.output, "```");
  }

  // Note which files had hostedMode guards added
  const guardedFiles = changedFiles.filter(f =>
    f.startsWith("ui/src/") && !f.includes("__tests__")
  );
  if (guardedFiles.length > 0) {
    internalLines.push("", "## Files Potentially Needing hostedMode Guards", "");
    for (const f of guardedFiles) {
      internalLines.push(`- ${f}`);
    }
  }

  // Note conflicts resolved
  internalLines.push("", "---", "", `*Generated by generate-changelog.mjs on ${new Date().toISOString()}*`);

  const internalPath = join(internalDir, `${TODAY}.md`);
  writeFileSync(internalPath, internalLines.join("\n") + "\n");
  log(`Wrote internal changelog: changelogs/internal/${TODAY}.md`);

  // --- User-facing changelog (filtered JSON) ---

  const userDir = join(CWD, "changelogs", "user-facing");
  mkdirSync(userDir, { recursive: true });

  const sections = { New: [], Improved: [], Fixed: [] };

  for (const c of commits) {
    // Get files changed in this specific commit
    const commitFiles = tryRun(`git diff-tree --no-commit-id --name-only -r ${c.hash}`);
    const cFiles = commitFiles.ok ? commitFiles.output.split("\n").filter(Boolean) : [];

    // Filter out infrastructure changes
    if (isInfraChange(c.message, cFiles)) continue;

    const category = categorize(c.message);
    if (!category) continue; // skip docs/chore/ci/build/test

    const cleaned = cleanCommitMessage(c.message);
    if (cleaned && !sections[category].includes(cleaned)) {
      sections[category].push(cleaned);
    }
  }

  // Build sections array (only include non-empty sections)
  const jsonSections = [];
  for (const title of ["New", "Improved", "Fixed"]) {
    if (sections[title].length > 0) {
      jsonSections.push({ title, items: sections[title] });
    }
  }

  const userFacingData = {
    version: TODAY,
    date: TODAY,
    sections: jsonSections,
  };

  const userPath = join(userDir, `${TODAY}.json`);
  writeFileSync(userPath, JSON.stringify(userFacingData, null, 2) + "\n");
  log(`Wrote user-facing changelog: changelogs/user-facing/${TODAY}.json`);

  // Update latest.json symlink
  const latestPath = join(userDir, "latest.json");
  try {
    unlinkSync(latestPath);
  } catch {
    // doesn't exist yet
  }
  symlinkSync(`${TODAY}.json`, latestPath);
  log(`Updated symlink: changelogs/user-facing/latest.json -> ${TODAY}.json`);

  return { generated: true, internalPath, userPath };
}

// Export for use by upstream-sync.mjs
const result = main();
if (!result.generated) {
  log("No changelog generated.");
}
