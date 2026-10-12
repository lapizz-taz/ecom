import fs from "node:fs/promises";
import path from "node:path";
import { contentBackend, UPLOAD_DIR } from "@/lib/server/content-store";

export const runtime = "nodejs";

const TYPES: Record<string, string> = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", avif: "image/avif" };

/** Serves images uploaded in local development (production uploads live in Supabase Storage). */
export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (contentBackend() !== "local-file" || !/^[a-z0-9-]+\.(jpg|png|webp|avif)$/.test(file)) {
    return new Response("Not found", { status: 404 });
  }
  try {
    const bytes = await fs.readFile(path.join(UPLOAD_DIR, file));
    return new Response(new Uint8Array(bytes), {
      headers: {
        "Content-Type": TYPES[file.split(".").pop()!],
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}
