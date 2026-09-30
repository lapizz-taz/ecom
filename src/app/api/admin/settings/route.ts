import { NextResponse } from "next/server";
import { z } from "zod";
import { apiError, requireApiSession } from "@/lib/auth";
import { getSettings, SETTINGS_KEYS, updateSettings, type SettingsKey } from "@/lib/config/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    await requireApiSession(req);
    return NextResponse.json(await getSettings({ fresh: true }));
  } catch (err) {
    return apiError(err);
  }
}

const bodySchema = z.object({ key: z.enum(SETTINGS_KEYS as [SettingsKey, ...SettingsKey[]]), value: z.unknown() });

/** Admin only: update one settings section (validated against the settings schema). */
export async function PUT(req: Request) {
  try {
    const session = await requireApiSession(req, { role: "ADMIN" });
    const body = bodySchema.parse(await req.json());
    const saved = await updateSettings(body.key, body.value as never, session.email);
    return NextResponse.json({ ok: true, value: saved });
  } catch (err) {
    return apiError(err);
  }
}
