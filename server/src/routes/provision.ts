import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
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

/**
 * Paperclip adapter for the generic provision-server protocol.
 *
 * Maps generic provisioning operations to Paperclip's domain model:
 *   tenant → company
 *   agents → agents (with http adapter pointing at gateway)
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

      if (!existing) {
        const now = new Date();
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
      const created: CreatedAgent[] = [];
      const nameToId = new Map<string, string>();

      // First pass: create agents
      for (const spec of specs) {
        if (!spec.name || !spec.role) continue;
        const agent = await agents.create(tenantEntityId, {
          name: spec.name,
          role: spec.role,
          title: spec.title ?? null,
          adapterType: "http",
          adapterConfig: {
            url: gateway.url,
            headers: { Authorization: `Bearer ${gateway.apiKey}` },
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
