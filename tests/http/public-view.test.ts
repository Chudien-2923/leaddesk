import { expect, it } from "vitest";
import { EMPTY_FACTS } from "../../src/domain/qualification";
import type { ChatView } from "../../src/server/conversation/state";
import { publicChatView } from "../../src/server/conversation/public-view";

function savedView(): ChatView {
  const citation = { chunkId: "internal-chunk", documentId: "internal-document", releaseId: "internal-release", title: "Internal evidence", excerpt: "Published supporting text" };
  return {
    conversationId: "conversation", messages: [
      { id: "user", role: "user", text: "Xin chào" },
      { id: "assistant", role: "assistant", text: "Chào bạn", citations: [citation], model: { requestedModel: "google-antigravity/gemini-3.8-flash", reportedModel: "gemini-3.8-flash", fallbackUsed: false } },
    ], citations: [citation], facts: EMPTY_FACTS, factsVersion: 4, factsValidationPending: true,
    policyVersion: "policy", qualification: { status: "needs_info", missing: ["latest_message_validation"], reasons: [] }, missingFields: ["latest_message_validation"],
    contact: null, crm: { status: "unknown", operationId: "original-operation" }, allowedActions: ["message", "request_handoff"], slots: [], selectedSlot: null,
    booking: null, handoff: null, safeError: { code: "CRM_UNKNOWN", message: "The outcome is not confirmed." },
  };
}

it("keeps grounding and model diagnostics out of visitor responses including historical messages", () => {
  const result = publicChatView(savedView());
  expect(result.messages).toEqual([{ id: "user", role: "user", text: "Xin chào" }, { id: "assistant", role: "assistant", text: "Chào bạn" }]);
  expect(result).not.toHaveProperty("citations");
  expect(JSON.stringify(result)).not.toMatch(/internal-chunk|internal-document|internal-release|gemini|fallbackUsed|Internal evidence/);
});

it("preserves uncertain outcomes and consent-version gates while retaining backend audit evidence", () => {
  const original = savedView();
  const snapshot = structuredClone(original);
  const result = publicChatView(original);
  expect(result.crm).toEqual({ status: "unknown", operationId: "original-operation" });
  expect(result.allowedActions).toEqual(["message", "request_handoff"]);
  expect(result.safeError).toEqual(original.safeError);
  expect(result.factsValidationPending).toBe(true);
  expect(result.factsVersion).toBe(4);
  expect(result.policyVersion).toBe("policy");
  expect(original).toEqual(snapshot);
});
