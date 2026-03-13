import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, authAccounts } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { hashPassword } from "better-auth/crypto";
import {
  createProvisionRouter,
  type ProvisionAdapter,
  type ProvisionRequest,
  type ProvisionResponse,
  type AdminUser,
  type AgentSpec,
  type CreatedAgent,
} from "@wopr-network/provision-server";
import { companyService, agentService, accessService, logActivity } from "../services/index.js";

/** Default model for hosted agents routed through the metered gateway. */
const DEFAULT_GATEWAY_MODEL = "anthropic/claude-sonnet-4-20250514";

/** Directory where we persist the OpenCode gateway provider config. */
const GATEWAY_CONFIG_DIR = path.join(process.env.PAPERCLIP_HOME ?? "/data", ".opencode-gateway");

/**
 * Write an opencode.json that configures our metered inference gateway as an
 * OpenAI-compatible provider.  We write it to a dedicated directory and pass
 * OPENCODE_CONFIG_DIR via the adapter env so OpenCode finds it regardless of
 * which workspace cwd the agent runs in (OpenCode only walks up to the nearest
 * .git boundary, which won't reach a parent config).
 */
async function ensureGatewayProviderConfig(gatewayUrl: string): Promise<void> {
  const configPath = path.join(GATEWAY_CONFIG_DIR, "opencode.json");
  const config = {
    $schema: "https://opencode.ai/config.json",
    provider: {
      "paperclip-gateway": {
        npm: "@ai-sdk/openai-compatible",
        name: "Paperclip Gateway",
        options: {
          baseURL: gatewayUrl,
          apiKey: "{env:PAPERCLIP_GATEWAY_KEY}",
        },
        models: {
          [DEFAULT_GATEWAY_MODEL]: {
            name: "Claude Sonnet 4",
            limit: { context: 200000, output: 16384 },
          },
        },
      },
    },
    model: `paperclip-gateway/${DEFAULT_GATEWAY_MODEL}`,
  };
  await fs.mkdir(GATEWAY_CONFIG_DIR, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Paperclip adapter for the generic provision-server protocol.
 *
 * Maps generic provisioning operations to Paperclip's domain model:
 *   tenant → company
 *   agents → agents (opencode_local adapter routed through metered gateway)
 */
function createPaperclipAdapter(db: Db): ProvisionAdapter {
  const companies = companyService(db);
  const agents = agentService(db);
  const access = accessService(db);

  return {
    async createTenant(req: ProvisionRequest) {
      const company = await companies.create({
        name: req.tenantName,
        description: `wopr:${req.tenantId}`,
        budgetMonthlyCents: req.budgetCents ?? 0,
        requireBoardApprovalForNewAgents: false,
      });
      return { id: company.id, slug: company.issuePrefix };
    },

    async ensureUser(user: AdminUser) {
      const existing = await db
        .select({ id: authUsers.id })
        .from(authUsers)
        .where(eq(authUsers.id, user.id))
        .then((rows) => rows[0] ?? null);

      const now = new Date();
      if (!existing) {
        await db.insert(authUsers).values({
          id: user.id,
          name: user.name ?? user.email,
          email: user.email,
          emailVerified: true,
          image: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      // Ensure a credential account exists so the admin can sign in.
      // Password is a random UUID — admin must use "forgot password" to set theirs.
      const existingAccount = await db
        .select({ id: authAccounts.id })
        .from(authAccounts)
        .where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")))
        .then((rows) => rows[0] ?? null);

      if (!existingAccount) {
        const hash = await hashPassword(randomUUID());

        await db.insert(authAccounts).values({
          id: randomUUID(),
          accountId: user.id,
          providerId: "credential",
          userId: user.id,
          password: hash,
          createdAt: now,
          updatedAt: now,
        });
      }
    },

    async grantAccess(tenantEntityId: string, userId: string) {
      await access.ensureMembership(tenantEntityId, "user", userId, "owner", "active");
      await access.promoteInstanceAdmin(userId);
    },

    async seedAgents(
      tenantEntityId: string,
      specs: AgentSpec[],
      gateway: { url: string; apiKey: string },
    ): Promise<CreatedAgent[]> {
      // Ensure the gateway provider config exists so OpenCode can resolve
      // the "paperclip-gateway" provider at agent execution time.
      await ensureGatewayProviderConfig(gateway.url);

      const created: CreatedAgent[] = [];
      const nameToId = new Map<string, string>();

      // First pass: create agents with the opencode_local adapter.
      // The gateway key is passed via env so the AI SDK provider picks it up
      // through the {env:PAPERCLIP_GATEWAY_KEY} reference in opencode.json.
      for (const spec of specs) {
        if (!spec.name || !spec.role) continue;
        const agent = await agents.create(tenantEntityId, {
          name: spec.name,
          role: spec.role,
          title: spec.title ?? null,
          adapterType: "opencode_local",
          adapterConfig: {
            model: `paperclip-gateway/${DEFAULT_GATEWAY_MODEL}`,
            env: {
              PAPERCLIP_GATEWAY_KEY: gateway.apiKey,
              OPENCODE_CONFIG_DIR: GATEWAY_CONFIG_DIR,
            },
          },
          budgetMonthlyCents: spec.budgetMonthlyCents ?? 0,
          status: "idle",
        });
        created.push({ id: agent.id, name: agent.name, role: agent.role });
        nameToId.set(spec.name, agent.id);
      }

      // Second pass: wire reportsTo
      for (const spec of specs) {
        if (!spec.reportsTo) continue;
        const agentId = nameToId.get(spec.name);
        const managerId = nameToId.get(spec.reportsTo);
        if (agentId && managerId) {
          await agents.update(agentId, { reportsTo: managerId });
        }
      }

      return created;
    },

    async updateBudget(tenantEntityId: string, budgetCents: number) {
      await companies.update(tenantEntityId, { budgetMonthlyCents: budgetCents });
    },

    async updateAgentBudgets(tenantEntityId: string, perAgentCents: number) {
      const companyAgents = await agents.list(tenantEntityId);
      for (const agent of companyAgents) {
        await agents.update(agent.id, { budgetMonthlyCents: perAgentCents });
      }
    },

    async tenantExists(tenantEntityId: string) {
      const company = await companies.getById(tenantEntityId);
      return company != null;
    },

    async teardown(tenantEntityId: string) {
      await companies.remove(tenantEntityId);
    },

    async onProvisioned(req: ProvisionRequest, _result: ProvisionResponse) {
      await logActivity(db, {
        companyId: _result.tenantEntityId,
        actorType: "user",
        actorId: "wopr-platform",
        action: "company.provisioned",
        entityType: "company",
        entityId: _result.tenantEntityId,
        details: {
          tenantId: req.tenantId,
          adminUserId: req.adminUser.id,
          adminEmail: req.adminUser.email,
        },
      });
    },
  };
}

/**
 * Create the provisioning Express router for Paperclip.
 *
 * Mount at `/internal`:
 *   app.use("/internal", provisionRoutes(db));
 */
export function provisionRoutes(db: Db) {
  return createProvisionRouter(createPaperclipAdapter(db));
}
