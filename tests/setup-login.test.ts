import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as setupPost } from "@/app/api/setup/route";
import { POST as loginPost } from "@/app/api/auth/login/route";
import { GET as health } from "@/app/api/health/route";
import { resetDb } from "./helpers";

const SECRET = process.env.NEXTAUTH_SECRET!;
let ipCounter = 0;

function req(path: string, body: object, proto = "http") {
  ipCounter++;
  return new Request(`${proto}://app.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "app.test", origin: `${proto}://app.test`, "x-forwarded-for": `10.0.0.${ipCounter}` },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  await resetDb();
  process.env.NEXTAUTH_SECRET = SECRET;
  delete process.env.ADMIN_EMAIL;
});
afterEach(() => {
  process.env.NEXTAUTH_SECRET = SECRET;
});

describe("first-time setup & login diagnostics", () => {
  it("tells the user to run setup when no admin exists", async () => {
    const res = await loginPost(req("/api/auth/login", { email: "a@b.co", password: "whatever" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ setup: true });
    expect((await (await health()).json()).adminExists).toBe(false);
  });

  it("explains a too-short NEXTAUTH_SECRET instead of a generic error", async () => {
    process.env.NEXTAUTH_SECRET = "short";
    const res = await loginPost(req("/api/auth/login", { email: "a@b.co", password: "x" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/NEXTAUTH_SECRET is too short/);
  });

  it("requires the setup key, enforces the password policy and ADMIN_EMAIL", async () => {
    expect((await setupPost(req("/api/setup", { setupKey: "wrong", email: "owner@iso.test", password: "GoodPassword123" }))).status).toBe(401);
    expect((await setupPost(req("/api/setup", { setupKey: SECRET, email: "owner@iso.test", password: "weak" }))).status).toBe(400);
    process.env.ADMIN_EMAIL = "owner@iso.test";
    expect((await setupPost(req("/api/setup", { setupKey: SECRET, email: "someone@else.test", password: "GoodPassword123" }))).status).toBe(400);
    expect(await prisma.adminUser.count()).toBe(0);
  });

  it("creates the first admin once, then login works (cookie not Secure on http)", async () => {
    const ok = await setupPost(req("/api/setup", { setupKey: SECRET, email: "Owner@Iso.test", password: "GoodPassword123" }));
    expect(ok.status).toBe(200);
    const again = await setupPost(req("/api/setup", { setupKey: SECRET, email: "x@iso.test", password: "GoodPassword123" }));
    expect(again.status).toBe(409);
    expect(await prisma.adminUser.count()).toBe(1);

    const bad = await loginPost(req("/api/auth/login", { email: "owner@iso.test", password: "WrongPassword123" }));
    expect(bad.status).toBe(401);
    const login = await loginPost(req("/api/auth/login", { email: "owner@iso.test", password: "GoodPassword123" }));
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toMatch(/iso_admin_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).not.toMatch(/Secure/i);

    const https = await loginPost(req("/api/auth/login", { email: "owner@iso.test", password: "GoodPassword123" }, "https"));
    expect(https.headers.get("set-cookie")).toMatch(/Secure/i);
  });
});
