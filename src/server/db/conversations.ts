import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { getPool, getQueryExecutor } from "./pool";

export interface ConversationOwner { conversationId: string; token: string }
export interface Conversation {
  id: string;
  state: Record<string, unknown>;
  facts: Record<string, unknown>;
  factsVersion: number;
  factsValidationPending: boolean;
  policyVersion: string | null;
}
export interface SaveConversationInput extends ConversationOwner {
  state: Record<string, unknown>;
  facts?: Record<string, unknown>;
  factsVersion?: number;
  factsValidationPending?: boolean;
  policyVersion?: string;
}
export interface ConversationRepository {
  createConversation(): Promise<{ id: string; token: string }>;
  getConversation(owner: ConversationOwner): Promise<Conversation>;
  saveConversation(input: SaveConversationInput): Promise<Conversation>;
}

const ownerSchema = z.object({ conversationId: z.string().uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });
const jsonObject = z.record(z.string(), z.unknown());
const saveSchema = ownerSchema.extend({
  state: jsonObject,
  facts: jsonObject.optional(),
  factsVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  policyVersion: z.string().min(1).max(128).optional(),
  factsValidationPending: z.boolean().optional(),
});
type ConversationRow = {
  id: string; state: Record<string, unknown>; facts: Record<string, unknown>;
  facts_version: string; policy_version: string | null;
  facts_validation_pending: boolean;
};
const columns = "id, state, facts, facts_version, policy_version, facts_validation_pending";
const asConversation = (row: ConversationRow): Conversation => ({
  id: row.id, state: row.state, facts: row.facts,
  factsVersion: Number(row.facts_version), policyVersion: row.policy_version,
  factsValidationPending: row.facts_validation_pending,
});

export function ownerTokenHash(owner: ConversationOwner): string {
  const parsed = ownerSchema.safeParse(owner);
  if (!parsed.success) throw Object.assign(new Error("Conversation access denied"), { code: "CONVERSATION_FORBIDDEN" });
  return createHash("sha256").update(parsed.data.token).digest("hex");
}

export async function assertConversationOwner(executor: Pool | PoolClient, owner: ConversationOwner): Promise<void> {
  const tokenHash = ownerTokenHash(owner);
  // Hash-qualified predicates avoid comparing bearer secrets in application code.
  const result = await executor.query("SELECT id FROM conversations WHERE id = $1 AND token_hash = $2", [owner.conversationId, tokenHash]);
  if (!result.rowCount) throw Object.assign(new Error("Conversation access denied"), { code: "CONVERSATION_FORBIDDEN" });
}

export function createConversationRepository(pool: Pool): ConversationRepository {
  return {
    async createConversation() {
      const token = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const result = await getQueryExecutor(pool).query<{ id: string }>(
        "INSERT INTO conversations (token_hash) VALUES ($1) RETURNING id", [tokenHash],
      );
      return { id: result.rows[0].id, token };
    },
    async getConversation(owner) {
      const tokenHash = ownerTokenHash(owner);
      const result = await getQueryExecutor(pool).query<ConversationRow>(
        `SELECT ${columns} FROM conversations WHERE id = $1 AND token_hash = $2`, [owner.conversationId, tokenHash],
      );
      if (!result.rowCount) throw Object.assign(new Error("Conversation access denied"), { code: "CONVERSATION_FORBIDDEN" });
      return asConversation(result.rows[0]);
    },
    async saveConversation(input) {
      const tokenHash = ownerTokenHash(input);
      const value = saveSchema.parse(input);
      const factsVersion = value.factsVersion ?? (value.state.factsVersion === undefined ? undefined : saveSchema.shape.factsVersion.parse(value.state.factsVersion));
      const policyVersion = value.policyVersion ?? (value.state.policyVersion === undefined ? undefined : saveSchema.shape.policyVersion.parse(value.state.policyVersion));
      const result = await getQueryExecutor(pool).query<ConversationRow>(
        `UPDATE conversations SET state = $3::jsonb, facts = COALESCE($4::jsonb, facts),
         facts_version = COALESCE($5::bigint, facts_version), policy_version = COALESCE($6, policy_version),
         facts_validation_pending = COALESCE($7::boolean, facts_validation_pending), updated_at = now()
         WHERE id = $1 AND token_hash = $2 RETURNING ${columns}`,
        [value.conversationId, tokenHash, JSON.stringify(value.state), value.facts === undefined ? null : JSON.stringify(value.facts), factsVersion ?? null, policyVersion ?? null, value.factsValidationPending ?? null],
      );
      if (!result.rowCount) throw Object.assign(new Error("Conversation access denied"), { code: "CONVERSATION_FORBIDDEN" });
      return asConversation(result.rows[0]);
    },
  };
}

export function createConversation(): Promise<{ id: string; token: string }> {
  return createConversationRepository(getPool()).createConversation();
}
