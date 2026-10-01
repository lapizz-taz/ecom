import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers read the session cookie and Host header through next/headers.
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined) }),
  headers: async () => new Headers({ host: "app.test" }),
}));

import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { SESSION_COOKIE, signSession } from "@/lib/auth/session";
import { POST as resetPost } from "@/app/api/setup/reset/route";
import { POST as changePost } from "@/app/api/auth/password/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { resetDb } from "./helpers";

const SECRET = process.env.NEXTAUTH_SECRET!;
let ip = 0;
function req(path: string, body: object) {
  ip++;
  return new Request(`http://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.test", origin: "http://app.test", "x-forwarded-for": `10.1.0.${ip}` },
    body: JSON.stringify(body),
  });
}
const login = (email: string, password: string) => loginPost(req("/api/auth/login", { email, password }));

beforeEach(async () => {
  await resetDb();
  jar.clear();
});

describe("forgot password (setup key)", () => {
  it("needs an existing admin, the right key and a strong password", async () => {
    expect((await resetPost(req("/api/setup/reset", { setupKey: SECRET, email: "owner@iso.test", password: "NewPassword123" }))).status).toBe(409);
    await prisma.adminUser.create({ data: { email: "owner@iso.test", role: "ADMIN", passwordHash: await hashPassword("OldPassword123") } });
    await prisma.adminUser.create({ data: { email: "agent@iso.test", role: "AGENT", passwordHash: await hashPassword("AgentPassword123") } });

    expect((await resetPost(req("/api/setup/reset", { setupKey: "wrong", email: "owner@iso.test", password: "NewPassword123" }))).status).toBe(401);
    expect((await resetPost(req("/api/setup/reset", { setupKey: SECRET, email: "owner@iso.test", password: "weak" }))).status).toBe(400);
    // Agents reset through an admin, not the setup key.
    expect((await resetPost(req("/api/setup/reset", { setupKey: SECRET, email: "agent@iso.test", password: "NewPassword123" }))).status).toBe(404);
    expect((await login("owner@iso.test", "OldPassword123")).status).toBe(200);
  });

  it("sets the new password and lifts an earlier sign-in lockout", async () => {
    await prisma.adminUser.create({ data: { email: "owner@iso.test", role: "ADMIN", passwordHash: await hashPassword("OldPassword123") } });
    for (let i = 0; i < 6; i++) await login("owner@iso.test", "GuessPassword123");
    expect((await login("owner@iso.test", "OldPassword123")).status).toBe(429);

    const ok = await resetPost(req("/api/setup/reset", { setupKey: SECRET, email: "Owner@Iso.test", password: "NewPassword123" }));
    expect(ok.status).toBe(200);
    expect((await login("owner@iso.test", "NewPassword123")).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: "setup.reset_admin_password" } })).toBe(1);
  });
});

describe("change my password (signed in)", () => {
  it("requires the current password, then switches to the new one", async () => {
    // Sign-in is only open once an admin exists.
    await prisma.adminUser.create({ data: { email: "owner@iso.test", role: "ADMIN", passwordHash: await hashPassword("OwnerPassword123") } });
    const user = await prisma.adminUser.create({ data: { email: "agent@iso.test", role: "AGENT", passwordHash: await hashPassword("OldPassword123") } });
    expect((await changePost(req("/api/auth/password", { currentPassword: "OldPassword123", newPassword: "NewPassword123" }))).status).toBe(401);

    jar.set(SESSION_COOKIE, await signSession({ sub: user.id, email: user.email, role: "AGENT" }));
    expect((await changePost(req("/api/auth/password", { currentPassword: "WrongPassword123", newPassword: "NewPassword123" }))).status).toBe(400);
    expect((await changePost(req("/api/auth/password", { currentPassword: "OldPassword123", newPassword: "short" }))).status).toBe(400);
    expect((await changePost(req("/api/auth/password", { currentPassword: "OldPassword123", newPassword: "NewPassword123" }))).status).toBe(200);

    expect((await login("agent@iso.test", "OldPassword123")).status).toBe(401);
    expect((await login("agent@iso.test", "NewPassword123")).status).toBe(200);
  });
});
