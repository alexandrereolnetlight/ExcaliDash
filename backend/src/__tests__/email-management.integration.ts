import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcrypt";
import request from "supertest";
import { getTestPrisma, setupTestDb } from "./testUtils";

const PASSWORD = "Correct-Horse-123!";

describe("email changes for SSO-managed accounts", () => {
  let prisma: ReturnType<typeof getTestPrisma>;
  let app: any;

  beforeAll(async () => {
    setupTestDb();
    prisma = getTestPrisma();
    ({ app } = await import("../index"));
    await prisma.systemConfig.upsert({
      where: { id: "default" },
      update: { authEnabled: true },
      create: { id: "default", authEnabled: true },
    });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    await prisma.user.create({
      data: { email: "local@example.test", name: "Local User", passwordHash },
    });
    // An OIDC-linked account that also has a password (e.g. it existed
    // locally before linking, or an admin issued a temporary password).
    const sso = await prisma.user.create({
      data: { email: "sso@example.test", name: "SSO User", passwordHash },
    });
    await prisma.authIdentity.create({
      data: {
        userId: sso.id,
        provider: "oidc",
        issuer: "https://login.example.test/v2.0",
        subject: "sso-subject",
        emailAtLink: "sso@example.test",
      },
    });
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  const signIn = async (email: string) => {
    const agent = request.agent(app);
    const csrf = await agent.get("/csrf-token");
    const login = await agent
      .post("/auth/login")
      .set(csrf.body.header, csrf.body.token)
      .send({ email, password: PASSWORD });
    expect(login.status).toBe(200);
    const fresh = await agent.get("/csrf-token");
    return { agent, csrf: fresh.body as { header: string; token: string } };
  };

  it("still lets a local-only account change its email", async () => {
    const { agent, csrf } = await signIn("local@example.test");
    const me = await agent.get("/auth/me");
    expect(me.body.user.emailManagedByIdentityProvider).toBe(false);
    const res = await agent
      .put("/auth/email")
      .set(csrf.header, csrf.token)
      .send({ email: "local-new@example.test", currentPassword: PASSWORD });
    expect(res.status).toBe(200);
    const stored = await prisma.user.findFirst({
      where: { name: "Local User" },
    });
    expect(stored?.email).toBe("local-new@example.test");
  });

  it("refuses email changes for an OIDC-linked account, even with the correct password", async () => {
    const { agent, csrf } = await signIn("sso@example.test");
    const me = await agent.get("/auth/me");
    expect(me.body.user.emailManagedByIdentityProvider).toBe(true);
    const res = await agent
      .put("/auth/email")
      .set(csrf.header, csrf.token)
      .send({ email: "hijack@example.test", currentPassword: PASSWORD });
    expect(res.status).toBe(403);
    const wrongPassword = await agent
      .put("/auth/email")
      .set(csrf.header, csrf.token)
      .send({ email: "hijack@example.test", currentPassword: "wrong" });
    // Same answer regardless of the password: no password oracle.
    expect(wrongPassword.status).toBe(403);
    const stored = await prisma.user.findFirst({ where: { name: "SSO User" } });
    expect(stored?.email).toBe("sso@example.test");
  });
});
