import { NextResponse } from "next/server";
import { describeProblems, getSetupStatus } from "@/lib/setup";

export const dynamic = "force-dynamic";

/** Health + configuration check. Reports only which setting is wrong, never values. */
export async function GET() {
  const status = await getSetupStatus();
  const problems = describeProblems(status);
  return NextResponse.json(
    {
      ok: problems.length === 0,
      database: status.database,
      sessionSecret: status.sessionSecret,
      adminExists: status.adminExists,
      problem: problems[0] ?? null,
      problems,
    },
    { status: problems.length ? 503 : 200 }
  );
}
