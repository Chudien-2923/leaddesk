import "server-only";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { z } from "zod";
import { assertConversationOwner, ownerTokenHash, type ConversationOwner } from "./conversations";
import { getQueryExecutor, withDatabaseConnection } from "./pool";

const heldConversationLocks = new AsyncLocalStorage<ReadonlyMap<Pool, string>>();

export type OperationKind = "crm" | "handoff" | "booking" | "crm_booking_update";
export type OperationStatus = "pending" | "succeeded" | "failed" | "unknown";
export interface Operation {
  id: string;
  conversationId: string;
  kind: OperationKind;
  key: string;
  payloadHash: string;
  status: OperationStatus;
  safeErrorCode: string | null;
  externalIds: Record<string, string>;
}
export interface OperationResult {
  status: Exclude<OperationStatus, "pending">;
  safeErrorCode: string | null;
  externalIds: Record<string, string>;
}
export interface ClaimOperationInput {
  conversationId: string; kind: OperationKind; key: string; payloadHash: string;
}
export interface OperationRepository {
  claimOperation(input: ClaimOperationInput): Promise<{ created: boolean; operation: Operation }>;
  finishOperation(id: string, patch: OperationResult): Promise<Operation>;
  getOperation(id: string): Promise<Operation>;
  withConversationLock<T>(conversationId: string, action: () => Promise<T>): Promise<T>;
}
const claimSchema = z.object({
  conversationId: z.string().uuid(),
  kind: z.enum(["crm", "handoff", "booking", "crm_booking_update"]),
  key: z.string().min(1).max(256), payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
});
const resultSchema = z.object({
  status: z.enum(["succeeded", "failed", "unknown"]),
  safeErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).nullable(),
  externalIds: z.record(z.string().min(1), z.string().min(1)),
}).refine((value) => value.status !== "succeeded" || value.safeErrorCode === null, "Success cannot have an error code");
interface OperationRow {
  id: string; conversation_id: string; kind: OperationKind; key: string; payload_hash: string;
  status: OperationStatus; safe_error_code: string | null; external_ids: Record<string, string>;
}
const toOperation = (row: OperationRow): Operation => ({
  id: row.id, conversationId: row.conversation_id, kind: row.kind, key: row.key,
  payloadHash: row.payload_hash, status: row.status, safeErrorCode: row.safe_error_code, externalIds: row.external_ids,
});
const denied = () => Object.assign(new Error("Operation access denied"), { code: "OPERATION_FORBIDDEN" });

export function createOperationRepository(pool: Pool, owner: ConversationOwner): OperationRepository {
  // Snapshot the capability so mutating a caller's object cannot rebind the service.
  const access = { ...owner };
  const assertBoundId = (id: string) => { if (id !== access.conversationId) throw denied(); };
  const repository: OperationRepository = {
    async claimOperation(input) {
      assertBoundId(input.conversationId);
      const value = claimSchema.parse(input);
      const executor = getQueryExecutor(pool);
      await assertConversationOwner(executor, access);
      const inserted = await executor.query<OperationRow>(
        `INSERT INTO integration_operations (conversation_id, kind, key, payload_hash)
         VALUES ($1, $2, $3, $4) ON CONFLICT (conversation_id, kind, key) DO NOTHING RETURNING *`,
        [value.conversationId, value.kind, value.key, value.payloadHash],
      );
      // A separate statement gets a fresh READ COMMITTED snapshot after a competing INSERT commits.
      const row = inserted.rows[0] ?? (await executor.query<OperationRow>(
        "SELECT * FROM integration_operations WHERE conversation_id = $1 AND kind = $2 AND key = $3",
        [value.conversationId, value.kind, value.key],
      )).rows[0];
      if (!row) throw new Error("Claimed operation is unavailable");
      if (row.payload_hash !== value.payloadHash) {
        throw Object.assign(new Error("Operation key has a different payload"), { code: "OPERATION_PAYLOAD_CONFLICT" });
      }
      return { created: inserted.rowCount === 1, operation: toOperation(row) };
    },
    async getOperation(id) {
      const hash = ownerTokenHash(access);
      const result = await getQueryExecutor(pool).query<OperationRow>(
        `SELECT o.* FROM integration_operations o JOIN conversations c ON c.id = o.conversation_id
         WHERE o.id = $1 AND c.id = $2 AND c.token_hash = $3`,
        [z.string().uuid().parse(id), access.conversationId, hash],
      );
      if (!result.rowCount) throw denied();
      return toOperation(result.rows[0]);
    },
    async finishOperation(id, patch) {
      const hash = ownerTokenHash(access);
      const value = resultSchema.parse(patch);
      const result = await getQueryExecutor(pool).query<OperationRow>(
        `UPDATE integration_operations o SET status = $4, safe_error_code = $5,
         external_ids = o.external_ids || $6::jsonb, updated_at = now()
         FROM conversations c WHERE o.id = $1 AND o.conversation_id = c.id AND c.id = $2 AND c.token_hash = $3
         AND (o.status = 'pending' OR (o.status IN ('failed', 'unknown') AND $4 = 'succeeded')) RETURNING o.*`,
        [z.string().uuid().parse(id), access.conversationId, hash, value.status, value.safeErrorCode, JSON.stringify(value.externalIds)],
      );
      if (result.rowCount) return toOperation(result.rows[0]);
      const current = await repository.getOperation(id);
      if (current.status === value.status && current.safeErrorCode === value.safeErrorCode
          && Object.keys(current.externalIds).length === Object.keys(value.externalIds).length
          && Object.entries(value.externalIds).every(([key, externalId]) => current.externalIds[key] === externalId)) return current;
      throw Object.assign(new Error("Operation result is already recorded"), { code: "OPERATION_RESULT_CONFLICT" });
    },
    async withConversationLock(conversationId, action) {
      assertBoundId(conversationId);
      const inherited = heldConversationLocks.getStore();
      if (inherited?.get(pool) === conversationId) {
        await assertConversationOwner(getQueryExecutor(pool), access);
        return action();
      }
      const client = await pool.connect();
      const lockKey = createHash("sha256").update(conversationId.toLowerCase()).digest().readBigInt64BE().toString();
      let locked = false;
      let discard = false;
      let failed = false;
      let acquiring = false;
      try {
        // Authorize on this connection: querying the pool here deadlocks at max: 1.
        await assertConversationOwner(client, access);
        acquiring = true;
        const result = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockKey]);
        acquiring = false;
        locked = result.rows[0].locked;
        if (!locked) throw Object.assign(new Error("Conversation is busy"), { code: "CONVERSATION_BUSY" });
        const scopedLocks = new Map(inherited);
        scopedLocks.set(pool, conversationId);
        return await withDatabaseConnection(pool, client, () => heldConversationLocks.run(scopedLocks, action));
      } catch (error) {
        failed = true;
        if (acquiring) discard = true;
        throw error;
      } finally {
        try {
          if (locked) {
            try {
              const result = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockKey]);
              if (!result.rows[0].unlocked) throw new Error("Conversation lock was not released");
            } catch (error) {
              discard = true;
              if (!failed) throw error;
            }
          }
        } finally {
          // Destroy a session whose unlock could not be confirmed; never return a held lock to the pool.
          client.release(discard);
        }
      }
    },
  };
  return repository;
}
