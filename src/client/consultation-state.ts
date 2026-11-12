import { z } from "zod";
import { contactSchema } from "@/domain/contact";
import type { ConversationEvent } from "@/server/conversation/state";

export interface ContactDraft { name: string; email: string; phone: string; reason: string }
export interface SavedIntent { event: ConversationEvent; fingerprint: string; uncertain: boolean; baselineMessageIds?: string[] }
export interface ConsultationDraft {
  updatedAt: number;
  message: string;
  contact: ContactDraft;
  handoff: ContactDraft;
  intents: SavedIntent[];
}
export const emptyContact = (): ContactDraft => ({ name: "", email: "", phone: "", reason: "" });
export const emptyDraft = (): ConsultationDraft => ({ updatedAt: Date.now(), message: "", contact: emptyContact(), handoff: emptyContact(), intents: [] });
const prefix = "leaddesk:consultation:";
const lifetime = 24 * 60 * 60 * 1000;
const recoveryKey = `${prefix}recovery`;
const recoverySchema = z.object({ conversationId: z.uuid(), updatedAt: z.number().finite() }).strict();
export function loadRecovery(): { conversationId: string | null; unavailable: boolean } {
  try {
    const value = sessionStorage.getItem(recoveryKey);
    if (value === null) return { conversationId: null, unavailable: false };
    const parsed = recoverySchema.safeParse(JSON.parse(value));
    if (!parsed.success || parsed.data.updatedAt > Date.now() + 60000) return { conversationId: null, unavailable: true };
    if (Date.now() - parsed.data.updatedAt > lifetime) {
      sessionStorage.removeItem(recoveryKey);
      sessionStorage.removeItem(prefix + parsed.data.conversationId);
      return { conversationId: null, unavailable: false };
    }
    return { conversationId: parsed.data.conversationId, unavailable: false };
  } catch { return { conversationId: null, unavailable: true }; }
}
const contactDraftSchema = z.object({ name: z.string().max(120), email: z.string().max(254), phone: z.string().max(32), reason: z.string().max(4000) }).strict();
const actionKey = z.string().min(1).max(256);
const factsVersion = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// Browser recovery has its own boundary validator; server-only modules stay out of the client bundle.
const recoveredEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message"), text: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ type: z.literal("submit_contact"), contact: contactSchema, consent: z.literal(true), factsVersion, key: actionKey }).strict(),
  z.object({ type: z.literal("request_handoff"), contact: contactSchema, consent: z.literal(true), reason: z.string().trim().min(1).max(4000), key: actionKey }).strict(),
  z.object({ type: z.literal("confirm_slot"), startUtc: z.iso.datetime({ offset: true }), factsVersion, confirmed: z.literal(true), key: actionKey }).strict(),
]);
const recoveredDraftSchema = z.object({
  updatedAt: z.number().finite(), message: z.string().max(4000), contact: contactDraftSchema, handoff: contactDraftSchema,
  intents: z.array(z.object({ event: recoveredEventSchema, fingerprint: z.string().max(20000), uncertain: z.boolean(), baselineMessageIds: z.array(z.string().max(256)).optional() }).strict()),
}).strict();
export function loadDraft(id: string): ConsultationDraft {
  try {
    const parsed = recoveredDraftSchema.safeParse(JSON.parse(sessionStorage.getItem(prefix + id) ?? "null"));
    if (!parsed.success || Date.now() - parsed.data.updatedAt > lifetime || parsed.data.updatedAt > Date.now() + 60000) {
      sessionStorage.removeItem(prefix + id);
      return emptyDraft();
    }
    return { ...parsed.data, intents: parsed.data.intents.filter(intent => eventFingerprint(intent.event) === intent.fingerprint) };
  } catch { return emptyDraft(); }
}
export function saveDraft(id: string, draft: ConsultationDraft): boolean {
  try {
    const updatedAt = Date.now();
    sessionStorage.setItem(prefix + id, JSON.stringify({ ...draft, updatedAt }));
    if (id !== "initial") sessionStorage.setItem(recoveryKey, JSON.stringify({ conversationId: id, updatedAt }));
    return true;
  }
  catch { return false; }
}
export function forgetDraft(id: string): void { try { sessionStorage.removeItem(prefix + id); } catch { /* Storage may be unavailable. */ } }
export function eventFingerprint(event: ConversationEvent): string {
  if ("key" in event) { const { key: _key, ...payload } = event; void _key; return JSON.stringify(payload); }
  return JSON.stringify(event);
}
