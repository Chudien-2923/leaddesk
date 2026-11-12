import { afterEach, describe, expect, it, vi } from "vitest";
import { assertCompletedVersions, assertStateTarget, parseOptions, requestLocal, targetConfiguration } from "../../scripts/smoke-local";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("local smoke mutation boundary", () => {
  // Removing the loopback-only origin gate would send visitor credentials or writes off-machine.
  it.each([
    "https://example.com", "http://127.0.0.1.example.com:3102", "http://192.168.1.2:3102",
    "http://0.0.0.0:3102", "http://127.1:3102", "http://2130706433:3102",
    "http://user:password@127.0.0.1:3102", "http://127.0.0.1:3102/path",
    "http://127.0.0.1:3102?token=secret", "http://[::ffff:127.0.0.1]:3102",
  ])("rejects dangerous origin %s before transport", (baseUrl) => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    expect(() => parseOptions(["--base-url", baseUrl, "--allow-test-writes"])).toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  // Reusing a visitor cookie against a different localhost app is still a credential leak.
  it.each(["http://127.0.0.1:3103", "http://localhost:3102", "https://example.com"]) (
    "rejects a resume state from %s", (baseUrl) => {
      const options = parseOptions(["--base-url", "http://127.0.0.1:3102"]);
      expect(() => assertStateTarget(options, { baseUrl })).toThrow();
    },
  );

  // Every app mutation, including model inference and creating a thread, needs explicit opt-in.
  it.each([
    ["/api/conversations", { acceptedDemoNotice: true }],
    ["/api/conversations/59e14ef5-e69f-485c-b674-c0af8cefcf88/events", { type: "message", text: "pricing" }],
    ["/api/conversations/59e14ef5-e69f-485c-b674-c0af8cefcf88/events", { type: "confirm_slot", confirmed: true }],
  ])("blocks unapproved mutation to %s", async (path, payload) => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const options = parseOptions(["--base-url", "http://127.0.0.1:3102"]);
    await expect(requestLocal(options, "", path as string, payload)).rejects.toThrow(/allow-test-writes/);
    expect(transport).not.toHaveBeenCalled();
  });

  // The app has no account-metadata endpoint: operators must attest its launch environment.
  it("blocks writes without the explicit running-server environment assertion", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const options = parseOptions(["--base-url", "http://127.0.0.1:3102", "--allow-test-writes"]);
    await expect(requestLocal(options, "", "/api/conversations", { acceptedDemoNotice: true })).rejects.toThrow(/server-uses-this-env/);
    expect(transport).not.toHaveBeenCalled();
  });

  // An absolute path could otherwise override the approved origin inside new URL().
  it("does not permit an approved write to override its local target", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const options = parseOptions(["--base-url", "http://127.0.0.1:3102", "--allow-test-writes", "--server-uses-this-env"]);
    await expect(requestLocal(options, "visitor=private", "https://example.com/api/conversations", {})).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it("refuses a local redirect rather than following a visitor cookie or mutation", async () => {
    const transport = vi.fn(async () => new Response(null, { status: 307, headers: { location: "https://example.com" } }));
    vi.stubGlobal("fetch", transport);
    const options = parseOptions(["--base-url", "http://127.0.0.1:3102", "--allow-test-writes", "--server-uses-this-env"]);
    await expect(requestLocal(options, "visitor=private", "/api/conversations", { acceptedDemoNotice: true })).rejects.toThrow(/redirect/i);
  });
});

describe("completed booking consent snapshots", () => {
  const saved = { facts_version: "3", policy_version: "approved-policy", consent_facts_version: "3", consent_policy_version: "approved-policy" };


  it.each([
    { ...saved, consent_facts_version: "4" },
    { ...saved, consent_policy_version: "different-policy" },
    { ...saved, facts_version: "4", consent_facts_version: "4" },
    { ...saved, policy_version: "different-policy", consent_policy_version: "different-policy" },
  ])("rejects consent or booking revisions that do not match the saved lead", (booking) => {
    expect(() => assertCompletedVersions(saved, booking)).toThrow(/consent_version_mismatch/);
  });
});

describe("approved database target boundary", () => {
  it.each(["user=postgres.otherprojectref12345", "host=unapproved.example.com", "port=6543", "dbname=other", "database=other", "sslrootcert=/tmp/ca&uselibpqcompat=true", "sslmode=verify-full&sslmode=no-verify"])("rejects query override %s before connecting", (override) => {
    const project = "abcdefghijklmnopqrst";
    const calendar = "0123456789abcdef0123456789abcdef@group.calendar.google.com";
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", `https://${project}.supabase.co`);
    vi.stubEnv("GOOGLE_CALENDAR_ID", calendar);
    vi.stubEnv("HUBSPOT_ACCESS_TOKEN", "synthetic-token-not-used");
    vi.stubEnv("DATABASE_URL", `postgresql://postgres.${project}:synthetic@aws-1-ap-south-1.pooler.supabase.com:5432/postgres?sslmode=verify-full&${override}`);
    const options = parseOptions(["--test-project-ref", project, "--test-hubspot-portal", "123456789", "--test-calendar-id", calendar]);
    expect(() => targetConfiguration(options)).toThrow();
  });
});
