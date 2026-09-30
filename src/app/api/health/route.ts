import { NextResponse } from "next/server";
import { describeProblem, getSetupStatus } from "@/lib/setup";

export const dynamic = "force-dynamic";

/** Health + configuration check. Reports only which setting is wrong, never values. */
export async function GET() {
  const status = await getSetupStatus();
  const problem = describeProblem(status);
  return NextResponse.json(
    { ok: !problem, database: status.database, sessionSecret: status.sessionSecret, adminExists: status.adminExists, problem },
    { status: problem ? 503 : 200 }
  );
}
