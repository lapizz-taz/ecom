import { NextResponse } from "next/server";
import { isAdminRequest, isSameOrigin } from "@/lib/server/admin-auth";
import { MAX_IMAGE_BYTES, saveImage } from "@/lib/server/content-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uploads one image (JPG, PNG, WebP, AVIF; max 5 MB) and returns its URL. */
export async function POST(req: Request) {
  if (!isAdminRequest(req)) return NextResponse.json({ ok: false, error: "Please log in again." }, { status: 401 });
  if (!isSameOrigin(req)) return NextResponse.json({ ok: false, error: "Blocked request." }, { status: 403 });
  if (Number(req.headers.get("content-length") || 0) > MAX_IMAGE_BYTES + 100_000) {
    return NextResponse.json({ ok: false, error: "Image is too large (max 5 MB)." }, { status: 413 });
  }
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "No file received." }, { status: 400 });
    const url = await saveImage(Buffer.from(await file.arrayBuffer()), file.name);
    return NextResponse.json({ ok: true, url });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed.";
    console.error("[cms] upload failed", err);
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}
