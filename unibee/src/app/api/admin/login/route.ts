import { NextResponse } from "next/server";
import { ADMIN_COOKIE, adminConfigured, checkPassword, createSession } from "@/lib/server/admin-auth";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const limit = rateLimit(`admin-login:${clientIp(req.headers)}`, 10, 15 * 60 * 1000);
  if (!limit.ok) return NextResponse.json({ ok: false, error: "Too many attempts. Try again in a few minutes." }, { status: 429 });
  if (!adminConfigured()) {
    return NextResponse.json({ ok: false, error: "Admin is not set up yet: add ADMIN_PASSWORD (8+ characters) to the environment." }, { status: 503 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !checkPassword(password)) {
    return NextResponse.json({ ok: false, error: "Wrong password." }, { status: 401 });
  }
  const session = createSession();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, session.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: session.maxAge,
  });
  return res;
}
