import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { startTestDatabase, type TestDatabase } from "./setup";

let db: TestDatabase;
// Swap only the DB connection boundary; use real PostgreSQL counters and production HTTP guards.
vi.mock("../../src/server/db/pool", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/server/db/pool")>(), getPool: () => db.pool,
}));
import { consumeRateLimit, limitConversationCreation } from "../../src/server/http/guards";
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); }, 30_000);

it("shares the five-creation allowance across ports and concurrent requests", async () => {
  const requests = Array.from({ length: 6 }, (_, index) => {
    const origin = `http://127.0.0.1:${index % 2 ? 3102 : 3112}`;
    return new Request(`${origin}/api/conversations`, { method: "POST", headers: { origin, host: new URL(origin).host } });
  });
  const results = await Promise.allSettled(requests.map(limitConversationCreation));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(5);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "RATE_LIMITED", status: 429 });
});

it("rejects message21 without spending another thread's twenty-message allowance", async () => {
  const subject = randomUUID();
  const results = await Promise.allSettled(Array.from({ length: 21 }, () => consumeRateLimit("message", subject)));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(20);
  const rejected = results.find(result => result.status === "rejected");
  expect(rejected?.status === "rejected" && rejected.reason).toMatchObject({ code: "RATE_LIMITED", status: 429 });
  // A separate visitor has its own allowance, not a shared message counter.
  const otherSubject = randomUUID();
  const other = await Promise.allSettled(Array.from({ length: 20 }, () => consumeRateLimit("message", otherSubject)));
  expect(other.every(result => result.status === "fulfilled")).toBe(true);
});

it("starts a new allowance only after the stored window has expired", async () => {
  const subject = randomUUID();
  await Promise.all(Array.from({ length: 5 }, () => consumeRateLimit("creation", subject)));
  await expect(consumeRateLimit("creation", subject)).rejects.toMatchObject({ code: "RATE_LIMITED" });
  const hash = createHash("sha256").update(subject).digest("hex");
  // Deliberate clock-boundary fixture in this disposable DB only, never the shared app's counter.
  await db.pool.query("UPDATE leaddesk_private.http_rate_limits SET window_start=now()-interval '61 minutes' WHERE scope='creation' AND key_hash=$1", [hash]);
  await consumeRateLimit("creation", subject);
  expect((await db.pool.query("SELECT used FROM leaddesk_private.http_rate_limits WHERE scope='creation' AND key_hash=$1", [hash])).rows[0].used).toBe(1);
});
