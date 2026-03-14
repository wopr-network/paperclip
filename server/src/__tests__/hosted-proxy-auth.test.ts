import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  isNull: vi.fn((col: unknown) => ["isNull", col]),
}));

vi.mock("@paperclipai/db", () => ({
  instanceUserRoles: {
    id: "id",
    userId: "userId",
    role: "role",
  },
  companyMemberships: {
    companyId: "companyId",
    principalType: "principalType",
    principalId: "principalId",
    status: "status",
  },
  agentApiKeys: {
    keyHash: "keyHash",
    revokedAt: "revokedAt",
    id: "id",
    agentId: "agentId",
    companyId: "companyId",
    lastUsedAt: "lastUsedAt",
  },
  agents: {
    id: "id",
    companyId: "companyId",
    status: "status",
  },
}));

vi.mock("../agent-auth-jwt.js", () => ({
  verifyLocalAgentJwt: vi.fn().mockReturnValue(null),
}));

import { actorMiddleware } from "../middleware/auth.js";

/** Build a mock DB that supports chained select().from().where().then() */
function createMockDb(opts?: {
  roleRow?: { id: string } | null;
  memberships?: { companyId: string }[];
}) {
  const roleRow = opts?.roleRow ?? null;
  const memberships = opts?.memberships ?? [];

  let callCount = 0;

  const thenFn = vi.fn().mockImplementation((cb) => {
    callCount++;
    // First select call = instanceUserRoles, second = companyMemberships
    if (callCount % 2 === 1) {
      return Promise.resolve(cb ? cb(roleRow ? [roleRow] : []) : roleRow ? [roleRow] : []);
    }
    return Promise.resolve(cb ? cb(memberships) : memberships);
  });

  const whereFn = vi.fn().mockReturnValue({ then: thenFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  const selectFn = vi.fn().mockReturnValue({ from: fromFn });

  return { select: selectFn, _fromFn: fromFn, _whereFn: whereFn, _thenFn: thenFn };
}

function createApp(mockDb: ReturnType<typeof createMockDb>) {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(mockDb as any, {
      deploymentMode: "hosted_proxy",
    }),
  );
  app.get("/test", (req, res) => {
    res.json(req.actor);
  });
  return app;
}

describe("hosted_proxy auth middleware", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets actor userId from x-paperclip-user-id header", async () => {
    mockDb = createMockDb();
    const app = createApp(mockDb);

    const res = await request(app).get("/test").set("x-paperclip-user-id", "user-42");

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("board");
    expect(res.body.userId).toBe("user-42");
    expect(res.body.source).toBe("hosted_proxy");
  });

  it("returns type none when header is missing", async () => {
    mockDb = createMockDb();
    const app = createApp(mockDb);

    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("none");
    expect(res.body.source).toBe("none");
  });

  it("looks up companyIds and isInstanceAdmin from DB", async () => {
    mockDb = createMockDb({
      roleRow: { id: "role-1" },
      memberships: [{ companyId: "comp-a" }, { companyId: "comp-b" }],
    });
    const app = createApp(mockDb);

    const res = await request(app).get("/test").set("x-paperclip-user-id", "user-99");

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("board");
    expect(res.body.userId).toBe("user-99");
    expect(res.body.isInstanceAdmin).toBe(true);
    expect(res.body.companyIds).toEqual(["comp-a", "comp-b"]);
    expect(res.body.source).toBe("hosted_proxy");
  });

  it("sets isInstanceAdmin false when no role row exists", async () => {
    mockDb = createMockDb({
      roleRow: null,
      memberships: [{ companyId: "comp-x" }],
    });
    const app = createApp(mockDb);

    const res = await request(app).get("/test").set("x-paperclip-user-id", "user-50");

    expect(res.status).toBe(200);
    expect(res.body.isInstanceAdmin).toBe(false);
    expect(res.body.companyIds).toEqual(["comp-x"]);
  });
});
