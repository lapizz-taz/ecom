import { NextResponse } from "next/server";
import { isAdminRequest, isSameOrigin } from "@/lib/server/admin-auth";
import { saveContent } from "@/lib/server/content-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Saves website content from the CMS. */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return NextResponse.json({ ok: false, error: "Please log in again." }, { status: 401 });
  if (!isSameOrigin(req)) return NextResponse.json({ ok: false, error: "Blocked request." }, { status: 403 });
  if (Number(req.headers.get("content-length") || 0) > 1_000_000) {
    return NextResponse.json({ ok: false, error: "Content is too large." }, { status: 413 });
  }
  let body: { content?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid data." }, { status: 400 });
  }
  try {
    const saved = await saveContent(body.content);
    return NextResponse.json({ ok: true, content: saved.data, updatedAt: saved.updatedAt });
  } catch (err) {
    console.error("[cms] save failed", err);
    const message = err instanceof Error && err.message.startsWith("Saving needs") ? err.message : "Couldn't save. Please try again.";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
