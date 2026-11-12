import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { contactSchema } from "../../domain/contact";
import type { Contact } from "../../domain/types";
import { createConversationRepository, type ConversationOwner } from "../db/conversations";
import { createOperationRepository } from "../db/operations";
import { getQueryExecutor } from "../db/pool";
import type { ActiveRelease } from "../db/releases";

export interface HandoffInput { contact: Contact; consent: true; reason: string }
export interface HandoffService { submitHandoff(input: HandoffInput, key: string): Promise<{ handoffId: string }> }
const inputSchema = z.object({ contact: contactSchema, consent: z.literal(true), reason: z.string().trim().min(1).max(4000) }).strict();

export function createHandoffService(options: { pool: Pool; owner: ConversationOwner; getActiveRelease: () => Promise<ActiveRelease> }): HandoffService {
  const { pool, getActiveRelease } = options;
  const owner = { ...options.owner };
  const conversations = createConversationRepository(pool);
  const operations = createOperationRepository(pool, owner);
  return {
    async submitHandoff(input, key) {
      const value = inputSchema.parse(input);
      return operations.withConversationLock(owner.conversationId, async () => {
        const conversation = await conversations.getConversation(owner);
        const { policy } = await getActiveRelease();
        const executor = getQueryExecutor(pool);
        await executor.query("BEGIN");
        try {
          const claim = await operations.claimOperation({ conversationId: owner.conversationId, kind: "handoff", key, payloadHash: createHash("sha256").update(JSON.stringify(value)).digest("hex") });
          const existing = await executor.query<{ id: string }>("SELECT id FROM handoff_requests WHERE conversation_id=$1", [owner.conversationId]);
          let handoffId = existing.rows[0]?.id;
          if (!handoffId) {
            const consent = await executor.query<{ id: string }>(
              "INSERT INTO consents(conversation_id,purpose,granted,facts_version,policy_version) VALUES($1,'handoff',true,$2,$3) RETURNING id",
              [owner.conversationId, conversation.factsVersion, policy.version],
            );
            const saved = await executor.query<{ id: string }>(
              "INSERT INTO handoff_requests(conversation_id,consent_id,operation_id,contact,reason) VALUES($1,$2,$3,$4::jsonb,$5) RETURNING id",
              [owner.conversationId, consent.rows[0].id, claim.operation.id, JSON.stringify(value.contact), value.reason],
            );
            handoffId = saved.rows[0].id;
          }
          if (claim.created) await operations.finishOperation(claim.operation.id, { status: "succeeded", safeErrorCode: null, externalIds: { handoffId } });
          await executor.query("COMMIT");
          return { handoffId };
        } catch (error) { await executor.query("ROLLBACK"); throw error; }
      });
    },
  };
}
