import express from "express";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stable mock instances — same objects returned by every factory call
const companySvcMock = {
  create: vi.fn(),
  getById: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
};
const agentSvcMock = {
  create: vi.fn(),
  list: vi.fn(),
  update: vi.fn(),
};
const accessSvcMock = {
  ensureMembership: vi.fn(),
  promoteInstanceAdmin: vi.fn(),
};
const logActivityMock = vi.fn();

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@paperclipai/db", () => ({
  authUsers: { id: "id" },
}));

vi.mock("../services/index.js", () => ({
  companyService: () => companySvcMock,
  agentService: () => agentSvcMock,
  accessService: () => accessSvcMock,
  logActivity: (...args: unknown[]) => logActivityMock(...args),
}));

import { provisionRoutes } from "../routes/provision.js";

const SECRET = "test-provision-secret-123";

/** Build a mock db that supports the chained select/insert calls. */
function createMockDb() {
  const thenFn = vi.fn().mockResolvedValue(null);
  const whereFn = vi.fn().mockReturnValue({ then: thenFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });
  const valuesFn = vi.fn().mockResolvedValue(undefined);
  const insertFn = vi.fn().mockReturnValue({ values: valuesFn });

  return {
    select: selectFn,
    insert: insertFn,
    _thenFn: thenFn,
    _whereFn: whereFn,
    _fromFn: fromFn,
    _valuesFn: valuesFn,
  };
}

function createApp(mockDb: ReturnType<typeof createMockDb>) {
  vi.stubEnv("WOPR_PROVISION_SECRET", SECRET);
  const app = express();
  app.use(express.json());
  app.use("/internal", provisionRoutes(mockDb as any));
  app.use(
    (
      err: any,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: err.message });
    },
  );
  return app;
}

describe("provision routes", () => {
  let app: express.Express;
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockDb = createMockDb();
    app = createApp(mockDb);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
  });

  describe("POST /internal/provision", () => {
    const validBody = {
      tenantId: "tenant-abc",
      tenantName: "Acme Corp",
      gatewayUrl: "https://api.wopr.network/v1",
      apiKey: "sk-tenant-xyz",
      budgetCents: 10000,
      adminUser: {
        id: "user-1",
        email: "admin@acme.com",
        name: "Admin",
      },
    };

    it("rejects requests without auth header", async () => {
      const res = await request(app).post("/internal/provision").send(validBody);
      expect(res.status).toBe(401);
    });

    it("rejects requests with wrong token", async () => {
      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", "Bearer wrong-token")
        .send(validBody);
      expect(res.status).toBe(401);
    });

    it("rejects requests missing required fields", async () => {
      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantId: "t1" });
      expect(res.status).toBe(422);
    });

    it("creates company, auth user, admin membership, and returns tenantEntityId", async () => {
      const fakeCompany = {
        id: "comp-1",
        name: "Acme Corp",
        issuePrefix: "ACM",
      };
      companySvcMock.create.mockResolvedValue(fakeCompany);
      accessSvcMock.ensureMembership.mockResolvedValue({});
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      logActivityMock.mockResolvedValue(undefined);
      // db.select().from().where().then() returns null => user doesn't exist
      mockDb._thenFn.mockResolvedValue(null);

      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send(validBody);

      expect(res.status).toBe(201);
      expect(res.body.tenantEntityId).toBe("comp-1");
      expect(res.body.tenantSlug).toBe("ACM");
      expect(res.body.adminUserId).toBe("user-1");

      expect(companySvcMock.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Acme Corp",
          description: "wopr:tenant-abc",
          budgetMonthlyCents: 10000,
        }),
      );

      // Auth user should be pre-created
      expect(mockDb.insert).toHaveBeenCalled();

      expect(accessSvcMock.ensureMembership).toHaveBeenCalledWith(
        "comp-1",
        "user",
        "user-1",
        "owner",
        "active",
      );
      expect(accessSvcMock.promoteInstanceAdmin).toHaveBeenCalledWith("user-1");
    });

    it("skips auth user creation if user already exists", async () => {
      const fakeCompany = { id: "comp-1", name: "Test", issuePrefix: "TST" };
      companySvcMock.create.mockResolvedValue(fakeCompany);
      accessSvcMock.ensureMembership.mockResolvedValue({});
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      logActivityMock.mockResolvedValue(undefined);
      // User already exists
      mockDb._thenFn.mockResolvedValue({ id: "user-1" });

      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send(validBody);

      expect(res.status).toBe(201);
      // insert should NOT be called for authUsers since user exists
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("creates starter agents with gateway config", async () => {
      const fakeCompany = { id: "comp-2", name: "Test", issuePrefix: "TST" };
      companySvcMock.create.mockResolvedValue(fakeCompany);
      accessSvcMock.ensureMembership.mockResolvedValue({});
      accessSvcMock.promoteInstanceAdmin.mockResolvedValue({});
      logActivityMock.mockResolvedValue(undefined);
      mockDb._thenFn.mockResolvedValue(null);

      let agentIdCounter = 0;
      agentSvcMock.create.mockImplementation(async (_cid: string, data: any) => ({
        id: `agent-${++agentIdCounter}`,
        name: data.name,
        role: data.role,
      }));
      agentSvcMock.update.mockResolvedValue({});

      const res = await request(app)
        .post("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({
          ...validBody,
          agents: [
            { name: "CEO", role: "ceo" },
            { name: "CTO", role: "cto", reportsTo: "CEO" },
          ],
        });

      expect(res.status).toBe(201);
      expect(res.body.agents).toHaveLength(2);
      expect(agentSvcMock.create).toHaveBeenCalledTimes(2);

      // Agent created with gateway adapter config
      expect(agentSvcMock.create).toHaveBeenCalledWith(
        "comp-2",
        expect.objectContaining({
          name: "CEO",
          role: "ceo",
          adapterType: "http",
          adapterConfig: expect.objectContaining({
            url: "https://api.wopr.network/v1",
          }),
        }),
      );

      // reportsTo wired up in second pass
      expect(agentSvcMock.update).toHaveBeenCalledWith("agent-2", { reportsTo: "agent-1" });
    });
  });

  describe("PUT /internal/provision/budget", () => {
    it("updates company budget", async () => {
      companySvcMock.getById.mockResolvedValue({ id: "comp-1", name: "Acme" });
      companySvcMock.update.mockResolvedValue({});

      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "comp-1", budgetCents: 50000 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(companySvcMock.update).toHaveBeenCalledWith("comp-1", {
        budgetMonthlyCents: 50000,
      });
    });

    it("updates per-agent budgets when specified", async () => {
      companySvcMock.getById.mockResolvedValue({ id: "comp-1", name: "Acme" });
      companySvcMock.update.mockResolvedValue({});
      agentSvcMock.list.mockResolvedValue([
        { id: "a1", name: "CEO" },
        { id: "a2", name: "CTO" },
      ]);
      agentSvcMock.update.mockResolvedValue({});

      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "comp-1", budgetCents: 50000, perAgentCents: 10000 });

      expect(res.status).toBe(200);
      expect(agentSvcMock.update).toHaveBeenCalledTimes(2);
      expect(agentSvcMock.update).toHaveBeenCalledWith("a1", { budgetMonthlyCents: 10000 });
      expect(agentSvcMock.update).toHaveBeenCalledWith("a2", { budgetMonthlyCents: 10000 });
    });

    it("returns 404 for unknown company", async () => {
      companySvcMock.getById.mockResolvedValue(null);
      const res = await request(app)
        .put("/internal/provision/budget")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "nonexistent", budgetCents: 100 });
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /internal/provision", () => {
    it("removes the company", async () => {
      companySvcMock.getById.mockResolvedValue({ id: "comp-1", name: "Acme" });
      companySvcMock.remove.mockResolvedValue({ id: "comp-1" });

      const res = await request(app)
        .delete("/internal/provision")
        .set("Authorization", `Bearer ${SECRET}`)
        .send({ tenantEntityId: "comp-1" });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(companySvcMock.remove).toHaveBeenCalledWith("comp-1");
    });
  });

  describe("GET /internal/provision/health", () => {
    it("returns health status without auth", async () => {
      const res = await request(app).get("/internal/provision/health");
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provisioning).toBe(true);
    });
  });
});
