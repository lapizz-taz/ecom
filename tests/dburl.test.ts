import { describe, expect, it } from "vitest";
import {
  classifyConnectionError,
  discoverPoolerHost,
  poolerHostCandidates,
  resolveDb,
  supabaseConnectionUrl,
  type ProbeResult,
} from "@/lib/dbUrl";

describe("database connection resolution", () => {
  it("builds Supabase pooler URLs and escapes the password", () => {
    const base = { host: "aws-1-ap-southeast-1.pooler.supabase.com", ref: "abc", password: "p@ss/w#rd?" };
    expect(supabaseConnectionUrl({ ...base, mode: "transaction" })).toBe(
      "postgresql://postgres.abc:p%40ss%2Fw%23rd%3F@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1"
    );
    expect(supabaseConnectionUrl({ ...base, mode: "session" })).toBe(
      "postgresql://postgres.abc:p%40ss%2Fw%23rd%3F@aws-1-ap-southeast-1.pooler.supabase.com:5432/postgres"
    );
    expect(poolerHostCandidates("ap-southeast-1")[0]).toBe("aws-0-ap-southeast-1.pooler.supabase.com");
  });

  it("prefers an explicit DATABASE_URL", () => {
    const r = resolveDb({ DATABASE_URL: "postgresql://x/y", SUPABASE_PROJECT_REF: "abc", SUPABASE_DB_PASSWORD: "pw" }, "h");
    expect(r).toMatchObject({ source: "explicit", databaseUrl: "postgresql://x/y", directUrl: "postgresql://x/y" });
  });

  it("composes the URL from the Supabase shortcut once the host is known", () => {
    const env = { SUPABASE_PROJECT_REF: "abc", SUPABASE_DB_PASSWORD: "pw" };
    expect(resolveDb(env, "").source).toBe("none");
    const r = resolveDb(env, "aws-1-ap-southeast-1.pooler.supabase.com");
    expect(r.source).toBe("supabase");
    expect(r.databaseUrl).toContain(":6543/postgres?pgbouncer=true");
    expect(r.directUrl).toContain(":5432/postgres");
    expect(resolveDb({ SUPABASE_PROJECT_REF: "abc" }, "h")).toMatchObject({ source: "none", supabaseMode: true, supabasePasswordSet: false });
  });

  it("classifies pooler / Postgres errors", () => {
    expect(classifyConnectionError("Tenant or user not found")).toBe("tenant_not_found");
    expect(classifyConnectionError('password authentication failed for user "postgres"')).toBe("auth_failed");
    expect(classifyConnectionError("getaddrinfo ENOTFOUND aws-3-ap-southeast-1.pooler.supabase.com")).toBe("unreachable");
    expect(classifyConnectionError("Connection terminated due to connection timeout")).toBe("unreachable");
  });

  it("walks the pooler clusters until one recognises the project", async () => {
    const hosts = ["aws-0", "aws-1", "aws-2"];
    const answers: Record<string, ProbeResult> = { "aws-0": "tenant_not_found", "aws-1": "ok", "aws-2": "ok" };
    const tried: string[] = [];
    const found = await discoverPoolerHost(hosts, async (h) => (tried.push(h), answers[h]!));
    expect(found).toEqual({ host: "aws-1", status: "ok" });
    expect(tried).toEqual(["aws-0", "aws-1"]);
  });

  it("stops at the first cluster that rejects the password (one failed login per deploy)", async () => {
    const tried: string[] = [];
    const found = await discoverPoolerHost(["aws-0", "aws-1", "aws-2"], async (h) => {
      tried.push(h);
      return h === "aws-0" ? "tenant_not_found" : "auth_failed";
    });
    expect(found).toEqual({ host: "aws-1", status: "auth_failed" });
    expect(tried).toEqual(["aws-0", "aws-1"]);
  });

  it("reports not_found vs unreachable when no cluster answers", async () => {
    expect(await discoverPoolerHost(["a", "b"], async () => "tenant_not_found")).toEqual({ host: null, status: "not_found" });
    expect(await discoverPoolerHost(["a", "b"], async (h) => (h === "a" ? "unreachable" : "tenant_not_found"))).toEqual({
      host: null,
      status: "unreachable",
    });
  });
});
