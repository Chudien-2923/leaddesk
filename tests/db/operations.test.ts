import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { createConversationRepository } from "../../src/server/db/conversations";
import {
  createOperationRepository,
  type OperationRepository,
} from "../../src/server/db/operations";
import { deferred, startTestDatabase, within, type TestDatabase } from "./setup";

interface Owner {
  conversationId: string;
  token: string;
}

const payloadHash = "a".repeat(64);
const differentPayloadHash = "b".repeat(64);
const succeeded = {
  status: "succeeded" as const,
  safeErrorCode: null,
  externalIds: { contactId: "synthetic-contact-A", noteId: "synthetic-note-A" },
};

describe("durable operations and advisory locks on real connections", () => {
  let database: TestDatabase | undefined;
  let poolA: Pool;
  let poolB: Pool;
  let ownerA: Owner;
  let ownerB: Owner;
  let operationsA: OperationRepository;
  let operationsB: OperationRepository;
  let secondConnectionA: OperationRepository;

  beforeAll(async () => {
    database = await startTestDatabase();
    // Single-connection pools guarantee contention crosses physical sessions.
    poolA = database.createPool(1);
    poolB = database.createPool(1);
  }, 120_000);

  beforeEach(async () => {
    const conversations = createConversationRepository(database!.pool);
    const [a, b] = await Promise.all([
      conversations.createConversation(),
      conversations.createConversation(),
    ]);
    ownerA = { conversationId: a.id, token: a.token };
    ownerB = { conversationId: b.id, token: b.token };
    operationsA = createOperationRepository(poolA, ownerA);
    operationsB = createOperationRepository(poolB, ownerB);
    secondConnectionA = createOperationRepository(poolB, ownerA);
  });

  afterAll(async () => {
    await database?.stop();
  }, 30_000);

  async function backendPids() {
    const [a, b] = await Promise.all([
      poolA.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
      poolB.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"),
    ]);
    const pids = [a.rows[0].pid, b.rows[0].pid];
    expect(pids[0]).not.toBe(pids[1]);
    return pids;
  }

  it("concurrent claims from different connections create exactly one durable pending operation", async () => {
    await backendPids();
    const input = { conversationId: ownerA.conversationId, kind: "crm" as const, key: "consent-1", payloadHash };
    const claims = await Promise.all([
      operationsA.claimOperation(input),
      secondConnectionA.claimOperation(input),
    ]);
    expect(claims.map((claim) => claim.created).sort()).toEqual([false, true]);
    expect(claims[0].operation.id).toBe(claims[1].operation.id);
    expect(claims[0].operation).toMatchObject({ ...input, status: "pending" });
    const rows = await database!.pool.query<{ id: string }>(
      "SELECT id FROM integration_operations WHERE conversation_id = $1",
      [ownerA.conversationId],
    );
    expect(rows.rows).toEqual([{ id: claims[0].operation.id }]);
    const reopened = createOperationRepository(database!.createPool(1), ownerA);
    expect(await reopened.getOperation(claims[0].operation.id)).toMatchObject({ ...input, status: "pending" });
  });

  it("replaying a finished key returns the saved IDs without resetting or duplicating the operation", async () => {
    const input = { conversationId: ownerA.conversationId, kind: "crm" as const, key: "consent-1", payloadHash };
    const claimed = await operationsA.claimOperation(input);
    await operationsA.finishOperation(claimed.operation.id, succeeded);
    const replay = await secondConnectionA.claimOperation(input);
    expect(replay.created).toBe(false);
    expect(replay.operation).toMatchObject({ id: claimed.operation.id, ...input, ...succeeded });
    expect(await secondConnectionA.getOperation(claimed.operation.id)).toMatchObject(succeeded);
    expect((await database!.pool.query("SELECT id FROM integration_operations WHERE conversation_id = $1", [ownerA.conversationId])).rowCount).toBe(1);
  });

  it("rejects a reused key with a different payload rather than overwriting or creating another operation", async () => {
    const input = { conversationId: ownerA.conversationId, kind: "booking" as const, key: "confirmation-1", payloadHash };
    const original = await operationsA.claimOperation(input);
    await operationsA.finishOperation(original.operation.id, succeeded);
    await expect(secondConnectionA.claimOperation({ ...input, payloadHash: differentPayloadHash })).rejects.toThrow();
    expect(await operationsA.getOperation(original.operation.id)).toMatchObject({ ...input, ...succeeded });
    expect((await database!.pool.query("SELECT id FROM integration_operations WHERE conversation_id = $1", [ownerA.conversationId])).rowCount).toBe(1);
  });

  it("namespaces the same key by both operation kind and conversation", async () => {
    const crm = await operationsA.claimOperation({ conversationId: ownerA.conversationId, kind: "crm", key: "same-key", payloadHash });
    const handoff = await operationsA.claimOperation({ conversationId: ownerA.conversationId, kind: "handoff", key: "same-key", payloadHash });
    const booking = await operationsA.claimOperation({ conversationId: ownerA.conversationId, kind: "booking", key: "same-key", payloadHash });
    const crmUpdate = await operationsA.claimOperation({ conversationId: ownerA.conversationId, kind: "crm_booking_update", key: "same-key", payloadHash });
    const otherOwner = await operationsB.claimOperation({ conversationId: ownerB.conversationId, kind: "crm", key: "same-key", payloadHash });
    const claims = [crm, handoff, booking, crmUpdate, otherOwner];
    expect(claims.every((claim) => claim.created)).toBe(true);
    expect(new Set(claims.map((claim) => claim.operation.id)).size).toBe(5);
  });

  it.each(["failed", "unknown"] as const)("persists %s outcomes and safe reconciliation IDs across replay", async (status) => {
    const input = { conversationId: ownerA.conversationId, kind: "crm" as const, key: "uncertain-write", payloadHash };
    const claimed = await operationsA.claimOperation(input);
    const outcome = { status, safeErrorCode: "CRM_NOTE_UNCONFIRMED", externalIds: { contactId: "synthetic-existing-contact" } };
    await operationsA.finishOperation(claimed.operation.id, outcome);
    const replay = await secondConnectionA.claimOperation(input);
    expect(replay.created).toBe(false);
    expect(replay.operation).toMatchObject({ id: claimed.operation.id, ...outcome });
    expect(await secondConnectionA.getOperation(claimed.operation.id)).toMatchObject(outcome);
  });

  it("rejects another owner's operation reads, results, claims and locks without modifying the owner's record", async () => {
    const input = { conversationId: ownerA.conversationId, kind: "crm" as const, key: "private-write", payloadHash };
    const claimed = await operationsA.claimOperation(input);
    await operationsA.finishOperation(claimed.operation.id, succeeded);
    await expect(operationsB.getOperation(claimed.operation.id)).rejects.toThrow();
    await expect(operationsB.finishOperation(claimed.operation.id, { status: "failed", safeErrorCode: "TAMPERED", externalIds: {} })).rejects.toThrow();
    await expect(operationsB.claimOperation(input)).rejects.toThrow();
    let ranAction = false;
    await expect(operationsB.withConversationLock(ownerA.conversationId, async () => { ranAction = true; })).rejects.toThrow();
    expect(ranAction).toBe(false);
    expect(await operationsA.getOperation(claimed.operation.id)).toMatchObject({ ...input, ...succeeded });
  });

  it("validates the bound token on every operation and lock, not only the supplied conversation ID", async () => {
    const input = { conversationId: ownerA.conversationId, kind: "crm" as const, key: "private-write", payloadHash };
    const claimed = await operationsA.claimOperation(input);
    const forgedOwner = createOperationRepository(poolB, { ...ownerA, token: ownerB.token });
    await expect(forgedOwner.getOperation(claimed.operation.id)).rejects.toThrow();
    await expect(forgedOwner.finishOperation(claimed.operation.id, succeeded)).rejects.toThrow();
    await expect(forgedOwner.claimOperation({ ...input, key: "forged-write" })).rejects.toThrow();
    let ranAction = false;
    await expect(forgedOwner.withConversationLock(ownerA.conversationId, async () => { ranAction = true; })).rejects.toThrow();
    expect(ranAction).toBe(false);
    expect(await operationsA.getOperation(claimed.operation.id)).toMatchObject({ status: "pending", payloadHash });
    expect((await database!.pool.query("SELECT id FROM integration_operations WHERE conversation_id = $1", [ownerA.conversationId])).rowCount).toBe(1);
  });

  it("holds a real session lock without a long transaction and releases it after an action throws", async () => {
    const [pidA] = await backendPids();
    const actionFailure = new Error("synthetic action failure");
    await expect(operationsA.withConversationLock(ownerA.conversationId, async () => {
      const observed = await poolB.query<{ locks: number; no_transaction: boolean }>(
        "SELECT (SELECT count(*)::int FROM pg_locks WHERE locktype = 'advisory' AND pid = $1 AND granted) AS locks, xact_start IS NULL AS no_transaction FROM pg_stat_activity WHERE pid = $1",
        [pidA],
      );
      expect(observed.rows[0]).toEqual({ locks: 1, no_transaction: true });
      throw actionFailure;
    })).rejects.toBe(actionFailure);

    const remaining = await poolB.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = $1",
      [pidA],
    );
    expect(remaining.rows[0].count).toBe(0);
    expect(await within(secondConnectionA.withConversationLock(ownerA.conversationId, async () => "reacquired"))).toBe("reacquired");
  });

  it("returns busy across actual connections, allows other conversations, and unlocks after success", async () => {
    const pids = await backendPids();
    const entered = deferred<void>();
    const release = deferred<void>();
    let contenderRan = false;
    const holder = operationsA.withConversationLock(ownerA.conversationId, async () => {
      entered.resolve();
      await release.promise;
      return "completed";
    });
    try {
      await within(Promise.race([entered.promise, holder]));
      await expect(within(secondConnectionA.withConversationLock(ownerA.conversationId, async () => {
        contenderRan = true;
      }))).rejects.toMatchObject({ code: "CONVERSATION_BUSY" });
      expect(contenderRan).toBe(false);
      expect(await within(operationsB.withConversationLock(ownerB.conversationId, async () => "independent"))).toBe("independent");
    } finally {
      release.resolve();
      await within(holder);
    }
    expect(await within(secondConnectionA.withConversationLock(ownerA.conversationId, async () => "released"))).toBe("released");
    const remaining = await database!.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND pid = ANY($1::int[])",
      [pids],
    );
    expect(remaining.rows[0].count).toBe(0);
  });
  it("permits nested services for the same authenticated conversation without a second session lock", async () => {
    const nested = createOperationRepository(database!.createPool(2), ownerA);
    const result = await nested.withConversationLock(ownerA.conversationId, async () =>
      nested.withConversationLock(ownerA.conversationId, async () => "nested-service-result"));
    expect(result).toBe("nested-service-result");
    const forged = createOperationRepository(database!.createPool(2), { ...ownerA, token: ownerB.token });
    await nested.withConversationLock(ownerA.conversationId, async () => {
      await expect(forged.withConversationLock(ownerA.conversationId, async () => "forbidden")).rejects.toThrow();
    });
  });
});
