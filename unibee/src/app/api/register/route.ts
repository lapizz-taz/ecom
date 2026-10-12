import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { coerceValues, toRecord, validateAll } from "@/lib/registration";
import { saveRegistration } from "@/lib/server/storage";
import { sendNotification } from "@/lib/server/email";
import { clientIp, rateLimit } from "@/lib/server/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MIN_FILL_MS = 3000; // humans can't finish 3 steps faster than this
const RATE_LIMIT = { count: 5, windowMs: 10 * 60 * 1000 }; // 5 submissions / 10 min / IP

export async function POST(req: Request) {
  if (Number(req.headers.get("content-length") || 0) > 32_000) {
    return NextResponse.json({ ok: false, error: "too_large" }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // Spam: honeypot field filled, or submitted impossibly fast → pretend success, store nothing.
  const startedAt = Number(body.startedAt) || 0;
  if ((typeof body.website === "string" && body.website.trim()) || (startedAt && Date.now() - startedAt < MIN_FILL_MS)) {
    return NextResponse.json({ ok: true });
  }

  const limit = rateLimit(`register:${clientIp(req.headers)}`, RATE_LIMIT.count, RATE_LIMIT.windowMs);
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "rate_limited", retryAfterSec: limit.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }

  const values = coerceValues(body.values);
  const errors = validateAll(values);
  if (Object.keys(errors).length) {
    return NextResponse.json({ ok: false, error: "invalid", errors }, { status: 422 });
  }

  const source = typeof body.source === "string" ? body.source.slice(0, 300) : "";
  const record = toRecord(values, { id: crypto.randomUUID(), createdAt: new Date().toISOString(), source });

  try {
    await saveRegistration(record);
  } catch (err) {
    console.error("[register] save failed", err);
    // Last resort: still try to email the lead so it isn't lost.
    try {
      const mail = await sendNotification(record);
      if (mail.sent) return NextResponse.json({ ok: true });
    } catch (mailErr) {
      console.error("[register] email fallback failed", mailErr);
    }
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }

  try {
    await sendNotification(record);
  } catch (err) {
    console.error("[register] email failed (registration was saved)", err);
  }

  return NextResponse.json({ ok: true });
}
