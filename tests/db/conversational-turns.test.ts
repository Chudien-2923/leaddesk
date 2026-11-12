import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { createPromptFunctions } from "../../src/server/ai/prompts";
import { PRIMARY_MODEL, type ModelResult } from "../../src/server/ai/types";
import { createConversationService } from "../../src/server/conversation/service";
import { createConversationRepository } from "../../src/server/db/conversations";
import { startTestDatabase, type TestDatabase } from "./setup";

// Real graph, prompts, validation, persistence and ownership; only model/network boundaries are controlled.
// Removing source-free conversational inference must lose persisted answer provenance and fail this test.
describe("conversational turns without retrieved agency evidence", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
  afterAll(async () => { await db?.stop(); }, 30_000);

  it("persists a model-backed conversational reply without inventing sources or opening integrations", async () => {
    const repo = createConversationRepository(db.pool);
    const created = await repo.createConversation();
    const owner = { conversationId: created.id, token: created.token };
    const prompts = createPromptFunctions(async input => ({
      text: input.purpose === "extract" ? JSON.stringify({ business: "clothing shop" })
        : JSON.stringify({ kind: "conversation", text: "What would you like help with for your shop?", sourceIds: [] }),
      requestedModel: PRIMARY_MODEL, reportedModel: PRIMARY_MODEL, fallbackUsed: false,
    } satisfies ModelResult));
    const dependencies = {
      pool: db.pool, owner, getActiveRelease: async () => ({ releaseId: "44444444-4444-4444-8444-444444444444", policy: DEFAULT_POLICY }),
      retrieveContext: async () => ({ citations: [], text: "", estimatedTokens: 0 }),
      ...prompts,
      getLeadService: () => { throw new Error("Conversational text cannot authorize CRM"); },
      getBookingService: async () => { throw new Error("Conversational text cannot authorize Calendar"); },
      handoffService: { submitHandoff: async () => { throw new Error("No handoff consent"); } },
    };
    const view = await createConversationService(dependencies).handleEvent({
      type: "message", text: "My clothing shop needs some guidance; where should I start?",
    }, new AbortController().signal);
    expect(view.safeError).toBeNull();
    expect(view.messages.at(-1)?.model).toMatchObject({ requestedModel: PRIMARY_MODEL, fallbackUsed: false });
    expect(view.messages.at(-1)?.citations).toEqual([]);
    expect(view.facts.business).toBe("clothing shop");
    expect(view.allowedActions).toEqual(["message", "request_handoff"]);
    expect(view.crm.status).toBe("none");
    expect(view.booking).toBeNull();
    const reopened = await createConversationService(dependencies).getView();
    expect(reopened.messages.at(-1)?.model?.requestedModel).toBe(PRIMARY_MODEL);
    expect((await db.pool.query("SELECT count(*)::int AS count FROM integration_operations WHERE conversation_id=$1", [created.id])).rows[0].count).toBe(0);
  });
});
