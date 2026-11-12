import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { contactSchema } from "../../domain/contact";
import { agencyToday } from "../../domain/policy";
import { EMPTY_FACTS, leadFactsSchema, qualify } from "../../domain/qualification";
import type { LeadFacts } from "../../domain/types";
import {
  answerWithSources, extractLeadFacts,
  type AnswerInput, type AnswerResult, type ExtractionInput, type ExtractionResult,
} from "../ai/prompts";
import {
  estimateInputTokens, FALLBACK_MODEL, leadFactsUpdateSchema, matchesSelectedModel, ModelError,
  MODEL_SELECTORS, PRIMARY_MODEL, throwIfAborted, validateModelInput,
  type ModelInput, type ModelResult,
} from "../ai/types";
import { createBookingService, type BookingService } from "../booking/service";
import { createConversationRepository, type Conversation, type ConversationOwner } from "../db/conversations";
import { createOperationRepository } from "../db/operations";
import { getPool, getQueryExecutor } from "../db/pool";
import { createReleaseRepository, type ActiveRelease } from "../db/releases";
import { createConfiguredCalendarClient } from "../integrations/google-calendar";
import { createHubSpotClient } from "../integrations/hubspot";
import { createContextRetriever, MAX_CONTEXT_ESTIMATED_TOKENS, type RetrievalContext } from "../knowledge/retrieve";
import { createLeadService, type LeadService } from "../leads/crm";
import { createHandoffService, type HandoffService } from "../leads/handoff";
import {
  assertConversationPool, buildConversationGraph, prepareConversationGraph, runConversationGraph,
  type CompiledConversationGraph, type ConversationTurn,
} from "./graph";
import { allowedActions, conversationEventSchema, type ChatMessage, type ChatView, type ConversationEvent, type CrmViewStatus } from "./state";

/** pool must allow at least two connections: one owner lock and one checkpointer. */
export interface ConversationDependencies {
  pool: Pool;
  owner: ConversationOwner;
  getActiveRelease(): Promise<ActiveRelease>;
  retrieveContext(query: string, releaseId: string): Promise<Pick<RetrievalContext, "citations" | "text" | "estimatedTokens">>;
  extractLeadFacts(input: ExtractionInput, signal: AbortSignal): Promise<ExtractionResult>;
  answerWithSources(input: AnswerInput, signal: AbortSignal): Promise<AnswerResult>;
  getLeadService(): LeadService;
  getBookingService(): Promise<BookingService>;
  handoffService: HandoffService;
  now?: () => Date;
}
export interface ConversationService {
  handleEvent(event: ConversationEvent, signal: AbortSignal): Promise<ChatView>;
  getView(): Promise<ChatView>;
  getAvailability(): Promise<ChatView>;
}

const citationSchema = z.object({
  chunkId: z.string().uuid(), documentId: z.string().uuid(), releaseId: z.string().uuid(),
  title: z.string().min(1), excerpt: z.string().min(1),
}).strict();
const provenanceSchema = z.object({
  requestedModel: z.enum(MODEL_SELECTORS), reportedModel: z.string().min(1).max(256), fallbackUsed: z.boolean(),
}).strict();
const messageSchema = z.object({
  id: z.string().uuid(), role: z.enum(["user", "assistant"]), text: z.string(),
  citations: z.array(citationSchema).optional(), model: provenanceSchema.optional(),
}).strict();
const slotSchema = z.object({
  startUtc: z.iso.datetime({ offset: true }), endUtc: z.iso.datetime({ offset: true }), timeZone: z.literal("Asia/Ho_Chi_Minh"),
}).strict().refine(slot => Date.parse(slot.endUtc) > Date.parse(slot.startUtc));
const memorySchema = z.object({
  messages: z.array(messageSchema).default([]), citations: z.array(citationSchema).default([]),
  slots: z.array(slotSchema).default([]), selectedSlot: slotSchema.nullable().default(null),
  slotsFactsVersion: z.number().int().nonnegative().nullable().default(null),
  slotsPolicyVersion: z.string().nullable().default(null),
  selectionFactsVersion: z.number().int().nonnegative().nullable().default(null),
  selectionPolicyVersion: z.string().nullable().default(null),
  safeError: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/), message: z.string() }).strict().nullable().default(null),
});
type Memory = z.infer<typeof memorySchema>;
interface LeadRow {
  status: "pending" | "saved" | "partial" | "unknown" | "failed";
  operation_id: string; safe_error_code: string | null; facts_version: string; policy_version: string;
  contact_id: string | null; note_id: string | null; operation_status: string; has_consent: boolean;
  contact: unknown;
}
interface BookingRow {
  status: string; event_id: string; operation_id: string; start_utc: Date; end_utc: Date;
  time_zone: "Asia/Ho_Chi_Minh"; crm_sync_status: string;
}

function boundedHistory(messages: ChatMessage[], purpose: ModelInput["purpose"]): ModelInput["messages"] {
  const result: ModelInput["messages"] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    const candidate: ModelInput["messages"] = [{ role: message.role, content: message.text }, ...result];
    // Reserve room for prompt instructions, canonical facts and up to 3,000 retrieval tokens.
    if (result.length && estimateInputTokens({ purpose, messages: candidate }) > 1_500) break;
    validateModelInput({ purpose, messages: candidate });
    result.unshift(candidate[0]);
  }
  if (result.length) validateModelInput({ purpose, messages: result });
  return result;
}

function safeFailure(error: unknown): NonNullable<ChatView["safeError"]> {
  if (error instanceof ModelError) return {
    code: `MODEL_${error.code.toUpperCase()}`,
    message: error.code === "aborted" ? "Your request stopped. Information already saved has been kept." : "We couldn’t produce a verified answer. Information already saved has been kept. Please try again.",
  };
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const allowed: string[] = [
    "STALE_FACTS", "STALE_POLICY", "LEAD_NOT_QUALIFIED", "CONTACT_NOT_ALLOWED", "BOOKING_NOT_ALLOWED",
    "BOOKING_SELECTION_STALE", "SLOT_UNAVAILABLE", "CRM_PARTIAL", "CRM_UNKNOWN", "CRM_FAILED",
    "BOOKING_UNKNOWN", "BOOKING_FAILED", "CALENDAR_AVAILABILITY_UNAVAILABLE", "INTEGRATION_CONFIGURATION",
    "OPERATION_PAYLOAD_CONFLICT", "BOOKING_STALE", "KNOWLEDGE_NOT_READY",
  ];
  return {
    code: typeof code === "string" && allowed.includes(code) ? code : "CONVERSATION_UNAVAILABLE",
    message: "We couldn’t complete this request. No successful outcome has been assumed. Check the current status or ask the team for help.",
  };
}

export function createConversationService(dependencies: ConversationDependencies): ConversationService {
  assertConversationPool(dependencies.pool);
  const deps = { ...dependencies, owner: { ...dependencies.owner } };
  const { pool, owner } = deps;
  const conversations = createConversationRepository(pool);
  const operations = createOperationRepository(pool, owner);
  const now = deps.now ?? (() => new Date());
  let graph: CompiledConversationGraph | undefined;

  function session(event?: ConversationEvent, signal = new AbortController().signal) {
    let conversation: Conversation;
    let release: ActiveRelease;
    let facts: LeadFacts;
    let memory: Memory;
    let view: ChatView;
    const problem: (code: string) => never = code => { throw Object.assign(new Error(code), { code }); };
    function clearSelection() {
      memory.selectedSlot = null;
      memory.selectionFactsVersion = null;
      memory.selectionPolicyVersion = null;
    }
    function clearSlots() {
      clearSelection();
      memory.slots = [];
      memory.slotsFactsVersion = null;
      memory.slotsPolicyVersion = null;
    }
    async function persist(updatedFacts?: LeadFacts) {
      conversation = await conversations.saveConversation({
        ...owner, state: memory, policyVersion: release.policy.version,
        factsValidationPending: conversation.factsValidationPending,
        ...(updatedFacts ? { facts: { ...updatedFacts }, factsVersion: conversation.factsVersion } : {}),
      });
    }
    async function read(): Promise<ChatView> {
      conversation = await conversations.getConversation(owner);
      release = await deps.getActiveRelease();
      facts = Object.keys(conversation.facts).length === 0 ? leadFactsSchema.parse(EMPTY_FACTS) : leadFactsSchema.parse(conversation.facts);
      memory = memorySchema.parse(conversation.state);
      const qualification = conversation.factsValidationPending
        ? { status: "needs_info" as const, missing: ["latest_message_validation"], reasons: [] }
        : qualify(facts, release.policy, agencyToday(now()));
      const stalePolicy = conversation.policyVersion !== release.policy.version;
      const staleSlots = memory.slotsFactsVersion !== conversation.factsVersion || memory.slotsPolicyVersion !== release.policy.version;
      const staleSelection = memory.selectionFactsVersion !== conversation.factsVersion || memory.selectionPolicyVersion !== release.policy.version;
      let changed = stalePolicy;
      if (staleSlots && (memory.slots.length || memory.selectedSlot)) { clearSlots(); changed = true; }
      else if (staleSelection && memory.selectedSlot) { clearSelection(); changed = true; }
      const executor = getQueryExecutor(pool);
      // All raw business reads are inside an authenticated conversation lock.
      const lead = (await executor.query<LeadRow>(`
        SELECT l.status,l.operation_id,l.safe_error_code,l.facts_version,l.policy_version,l.contact_id,l.note_id,l.contact,
          o.status AS operation_status,
          (c.granted AND c.purpose='crm' AND c.facts_version=$2 AND c.policy_version=$3) AS has_consent
        FROM lead_submissions l JOIN consents c ON c.id=l.consent_id AND c.conversation_id=l.conversation_id
        JOIN integration_operations o ON o.id=l.operation_id AND o.conversation_id=l.conversation_id
        WHERE l.conversation_id=$1`, [owner.conversationId, conversation.factsVersion, release.policy.version])).rows[0];
      const currentLead = !!lead && Number(lead.facts_version) === conversation.factsVersion && lead.policy_version === release.policy.version;
      const hasConsent = !!lead && currentLead && lead.has_consent;
      let crmStatus: CrmViewStatus = !lead ? "none" : lead.status === "pending" ? "unknown" : lead.status;
      if (lead?.status === "saved" && (!currentLead || !hasConsent || !lead.contact_id || !lead.note_id)) crmStatus = "none";
      if (lead && ["pending", "unknown"].includes(lead.operation_status)) crmStatus = "unknown";
      const booking = (await executor.query<BookingRow>(`
        SELECT status,event_id,operation_id,start_utc,end_utc,time_zone,crm_sync_status FROM bookings
        WHERE conversation_id=$1 ORDER BY CASE status WHEN 'booked' THEN 0 WHEN 'unknown' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END,created_at DESC LIMIT 1`,
      [owner.conversationId])).rows[0];
      const unresolved = (await executor.query(
        "SELECT id FROM integration_operations WHERE conversation_id=$1 AND status IN ('pending','unknown') LIMIT 1", [owner.conversationId],
      )).rowCount !== 0;
      const activeBooking = !!booking && ["pending", "unknown", "booked"].includes(booking.status);
      const eligible = qualification.status === "qualified" && crmStatus === "saved" && hasConsent && !unresolved && !activeBooking;
      if (!eligible && (memory.slots.length || memory.selectedSlot)) { clearSlots(); changed = true; }
      const handoff = (await executor.query<{ id: string }>("SELECT id FROM handoff_requests WHERE conversation_id=$1", [owner.conversationId])).rows[0];
      if (changed) await persist();
      view = {
        conversationId: owner.conversationId, messages: memory.messages, citations: memory.citations,
        facts, factsVersion: conversation.factsVersion, factsValidationPending: conversation.factsValidationPending, policyVersion: release.policy.version,
        qualification, missingFields: qualification.missing,
        crm: { status: crmStatus, ...(lead ? { operationId: lead.operation_id } : {}), ...(lead?.safe_error_code ? { safeCode: lead.safe_error_code } : {}) },
        contact: lead ? contactSchema.parse(lead.contact) : null,
        allowedActions: allowedActions({ qualification: qualification.status, crmStatus, hasConsent, selectedSlot: memory.selectedSlot?.startUtc ?? null, booked: activeBooking || unresolved, factsValidationPending: conversation.factsValidationPending }),
        slots: memory.slots, selectedSlot: memory.selectedSlot,
        booking: booking ? {
          status: booking.status, operationId: booking.operation_id, crmSyncStatus: booking.crm_sync_status,
          ...(booking.status === "booked" ? { eventId: booking.event_id } : {}),
          slot: { startUtc: booking.start_utc.toISOString(), endUtc: booking.end_utc.toISOString(), timeZone: booking.time_zone },
        } : null,
        handoff: handoff ? { status: "saved", handoffId: handoff.id } : null,
        safeError: memory.safeError,
      };
      return view;
    }
    async function recordModel(model: ModelResult | undefined, error?: unknown) {
      const failure = error instanceof ModelError ? error : error ? new ModelError("protocol", "Model task failed") : undefined;
      const trace = model?.trace?.length ? model.trace : failure?.trace.length ? failure.trace : [{
        requestedModel: model?.requestedModel ?? PRIMARY_MODEL,
        outcome: failure?.code ?? "success" as const,
      }];
      for (let index = 0; index < trace.length; index++) {
        const attempt = trace[index];
        const succeeded = attempt.outcome === "success" && !failure;
        const usage = succeeded && index === trace.length - 1 ? model?.usage : undefined;
        const tokens = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 && value! <= 2_147_483_647 ? value : null;
        await getQueryExecutor(pool).query(`
          INSERT INTO model_runs(conversation_id,provider,model,status,safe_error_code,input_tokens,output_tokens,finished_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,now())`, [
          owner.conversationId, attempt.requestedModel.split("/")[0], attempt.requestedModel,
          succeeded ? "succeeded" : "failed", succeeded ? null : `MODEL_${(failure && attempt.outcome === "success" ? failure.code : attempt.outcome).toUpperCase()}`,
          tokens(usage?.inputTokens), tokens(usage?.outputTokens),
        ]);
      }
    }
    async function modelTask<T extends { model?: ModelResult }>(action: () => Promise<T>, validate: (result: T) => void): Promise<T> {
      let result: T;
      try {
        result = await action();
        throwIfAborted(signal);
        if (result.model) {
          const provenance = provenanceSchema.parse({ requestedModel: result.model.requestedModel, reportedModel: result.model.reportedModel, fallbackUsed: result.model.fallbackUsed });
          if (!matchesSelectedModel(provenance.requestedModel, provenance.reportedModel) || provenance.fallbackUsed !== (provenance.requestedModel === FALLBACK_MODEL)) throw new ModelError("model_mismatch", "Invalid model provenance");
        }
        validate(result);
      } catch (error) {
        const failure = error instanceof ModelError ? error : new ModelError("protocol", "Model task did not return a valid result");
        await recordModel(undefined, failure);
        throw failure;
      }
      if (result.model) await recordModel(result.model);
      return result;
    }
    async function guarded(action: () => Promise<ChatView>): Promise<ChatView> {
      try { throwIfAborted(signal); return await action(); }
      catch (error) {
        // Reload first: a provider may have committed a canonical journal result before failing.
        await read();
        memory.safeError = safeFailure(error);
        await persist();
        return read();
      }
    }
    async function replayedOperation(kind: "crm" | "booking"): Promise<boolean> {
      let key: string;
      let payload: unknown;
      if (kind === "crm" && event?.type === "submit_contact") {
        key = event.key;
        payload = { contact: event.contact, consent: true, factsVersion: event.factsVersion };
      } else if (kind === "booking" && event?.type === "confirm_slot") {
        key = event.key;
        payload = { startUtc: new Date(event.startUtc).toISOString(), factsVersion: event.factsVersion, confirmed: true };
      } else return false;
      const prior = (await getQueryExecutor(pool).query<{ id: string; payload_hash: string; status: string }>(
        "SELECT id,payload_hash,status FROM integration_operations WHERE conversation_id=$1 AND kind=$2 AND key=$3",
        [owner.conversationId, kind, key],
      )).rows[0];
      if (!prior) return false;
      if (prior.payload_hash !== createHash("sha256").update(JSON.stringify(payload)).digest("hex")) problem("OPERATION_PAYLOAD_CONFLICT");
      if (kind === "crm") {
        if (prior.status === "succeeded" && view.crm.status === "saved") return true;
        if (prior.status === "succeeded") problem("STALE_POLICY");
        problem(view.crm.status === "partial" ? "CRM_PARTIAL" : ["pending", "unknown"].includes(prior.status) ? "CRM_UNKNOWN" : "CRM_FAILED");
      }
      if (prior.status === "succeeded" && view.booking?.status === "booked" && view.booking.operationId === prior.id) return true;
      problem(["pending", "unknown"].includes(prior.status) ? "BOOKING_UNKNOWN" : "BOOKING_FAILED");
    }
    async function listSlots(): Promise<ChatView> {
      await read();
      if (!view.allowedActions.includes("select_slot")) return view;
      const version = conversation.factsVersion;
      const policyVersion = release.policy.version;
      const slots = z.array(slotSchema).parse(await (await deps.getBookingService()).listSlots());
      await read();
      if (version !== conversation.factsVersion || policyVersion !== release.policy.version || !view.allowedActions.includes("select_slot")) problem("BOOKING_STALE");
      memory.slots = slots;
      memory.slotsFactsVersion = version;
      memory.slotsPolicyVersion = policyVersion;
      if (memory.selectedSlot && !slots.some(slot => slot.startUtc === memory.selectedSlot!.startUtc)) clearSelection();
      if (memory.safeError?.code === "CALENDAR_AVAILABILITY_UNAVAILABLE") memory.safeError = null;
      await persist();
      return read();
    }
    async function confirmGate(): Promise<ChatView> {
      if (event?.type !== "confirm_slot") problem("BOOKING_NOT_ALLOWED");
      await read();
      if (event.factsVersion !== conversation.factsVersion) problem("STALE_FACTS");
      if (await replayedOperation("booking")) return view;
      if (!memory.selectedSlot || memory.selectionFactsVersion !== conversation.factsVersion || memory.selectionPolicyVersion !== release.policy.version
        || new Date(event.startUtc).toISOString() !== new Date(memory.selectedSlot.startUtc).toISOString()) problem("BOOKING_SELECTION_STALE");
      if (!view.allowedActions.includes("confirm_slot")) problem("BOOKING_NOT_ALLOWED");
      return view;
    }
    const turn: ConversationTurn = {
      id: randomUUID(), event: event!,
      async load() {
        await read();
        memory.safeError = null;
        if (event?.type === "message") {
          conversation.factsValidationPending = true;
          clearSlots();
          memory.messages.push({ id: randomUUID(), role: "user", text: event.text });
        }
        await persist();
        return read();
      },
      extract: () => guarded(async () => {
        if (event?.type !== "message") problem("CONVERSATION_UNAVAILABLE");
        await read();
        const extracted = await modelTask(() => deps.extractLeadFacts({ messages: boundedHistory(memory.messages, "extract"), currentFacts: facts }, signal), result => {
          if (!result.model || !leadFactsUpdateSchema.safeParse(result.facts).success) throw new ModelError("invalid_extraction", "Invalid extracted facts");
        });
        const merged = leadFactsSchema.safeParse({ ...facts, ...extracted.facts });
        if (!merged.success) throw new ModelError("invalid_extraction", "Invalid merged lead facts");
        const changed = JSON.stringify(merged.data) !== JSON.stringify(facts);
        if (changed) {
          if (conversation.factsVersion === Number.MAX_SAFE_INTEGER) problem("STALE_FACTS");
          conversation.factsVersion++;
          facts = merged.data;
          clearSlots();
        }
        // Clear the durable fence only after validated extraction, including an unchanged result.
        conversation.factsValidationPending = false;
        await persist(changed ? facts : undefined);
        return read();
      }),
      answer: () => guarded(async () => {
        if (event?.type !== "message") problem("CONVERSATION_UNAVAILABLE");
        await read();
        // Resolve shorthand and follow-ups using the validated, current service, not model memory.
        const serviceTopic = facts.service === "meta_ads" ? "Meta Ads management" : facts.service === "google_ads" ? "Google Ads management" : "Meta Ads and Google Ads";
        const query = `${serviceTopic} services, pricing and consultation requirements. ${event.text}`;
        const context = await deps.retrieveContext(query, release.releaseId);
        const citations = z.array(citationSchema).parse(context.citations);
        if (!Number.isFinite(context.estimatedTokens) || context.estimatedTokens < 0 || context.estimatedTokens > MAX_CONTEXT_ESTIMATED_TOKENS
          || citations.some(citation => citation.releaseId !== release.releaseId) || new Set(citations.map(citation => citation.chunkId)).size !== citations.length) throw new ModelError("invalid_answer", "Invalid retrieval context");
        const sources = new Map(citations.map(citation => [citation.chunkId, citation]));
        const answered = await modelTask(() => deps.answerWithSources({
          question: event.text, history: boundedHistory(memory.messages.slice(0, -1), "answer"), facts, citations,
          consultation: {
            today: agencyToday(now()), qualification: view.qualification.status, missingFields: view.missingFields, crmStatus: view.crm.status,
            booking: view.booking ? { status: view.booking.status, ...(view.booking.slot ? { slot: view.booking.slot } : {}), ...(view.booking.crmSyncStatus ? { crmSyncStatus: view.booking.crmSyncStatus } : {}) } : null,
          },
        }, signal), result => {
          if (typeof result.text !== "string" || !result.text.trim() || !["conversation", "grounded", "unsupported"].includes(result.kind) || !result.model || !Array.isArray(result.sourceIds)
            || result.sourceIds.some(id => typeof id !== "string" || !sources.has(id)) || new Set(result.sourceIds).size !== result.sourceIds.length
            || (result.kind === "grounded" ? result.sourceIds.length === 0 : result.sourceIds.length !== 0)) throw new ModelError("invalid_answer", "Answer kind or evidence is invalid");
        });
        const finalCitations = answered.sourceIds.map(id => sources.get(id)!);
        memory.citations = finalCitations;
        memory.messages.push({ id: randomUUID(), role: "assistant", text: answered.text, citations: finalCitations,
          ...(answered.model ? { model: { requestedModel: answered.model.requestedModel, reportedModel: answered.model.reportedModel, fallbackUsed: answered.model.fallbackUsed } } : {}),
        });
        await persist();
        return read();
      }),
      qualify: read,
      consentGate: () => guarded(async () => {
        if (event?.type !== "submit_contact") problem("CONTACT_NOT_ALLOWED");
        await read();
        if (event.factsVersion !== conversation.factsVersion) problem("STALE_FACTS");
        if (await replayedOperation("crm")) return view;
        if (!view.allowedActions.includes("submit_contact")) problem("CONTACT_NOT_ALLOWED");
        return view;
      }),
      submitContact: () => guarded(async () => {
        if (event?.type !== "submit_contact") problem("CONTACT_NOT_ALLOWED");
        await read();
        if (event.factsVersion !== conversation.factsVersion) problem("STALE_FACTS");
        if (await replayedOperation("crm")) return view;
        if (!view.allowedActions.includes("submit_contact")) problem("CONTACT_NOT_ALLOWED");
        const result = await deps.getLeadService().submitLead({ contact: event.contact, consent: true, factsVersion: event.factsVersion }, event.key);
        await read();
        if (result.status === "saved" && view.crm.status !== "saved") problem("CRM_UNKNOWN");
        if (result.status !== "saved") problem(result.status === "partial" ? "CRM_PARTIAL" : result.status === "unknown" ? "CRM_UNKNOWN" : "CRM_FAILED");
        return view;
      }),
      listSlots: () => guarded(listSlots),
      selectSlot: () => guarded(async () => {
        if (event?.type !== "select_slot") problem("BOOKING_NOT_ALLOWED");
        await read();
        if (!view.allowedActions.includes("select_slot")) problem("BOOKING_NOT_ALLOWED");
        await listSlots();
        const selected = memory.slots.find(slot => new Date(slot.startUtc).toISOString() === new Date(event.startUtc).toISOString());
        if (!selected) problem("SLOT_UNAVAILABLE");
        memory.selectedSlot = selected;
        memory.selectionFactsVersion = conversation.factsVersion;
        memory.selectionPolicyVersion = release.policy.version;
        await persist();
        return read();
      }),
      confirmGate: () => guarded(confirmGate),
      confirmBooking: () => guarded(async () => {
        await confirmGate();
        if (await replayedOperation("booking")) return view;
        if (event?.type !== "confirm_slot" || !memory.selectedSlot) problem("BOOKING_SELECTION_STALE");
        const result = await (await deps.getBookingService()).confirmBooking({ startUtc: memory.selectedSlot.startUtc, factsVersion: conversation.factsVersion, confirmed: true }, event.key);
        await read();
        if (result.status === "booked" && view.booking?.status !== "booked") problem("BOOKING_UNKNOWN");
        if (result.status !== "booked") problem(result.status === "unknown" ? "BOOKING_UNKNOWN" : result.status === "stale" ? "BOOKING_STALE" : result.status === "slot_unavailable" ? "SLOT_UNAVAILABLE" : "BOOKING_FAILED");
        return view;
      }),
      handoff: () => guarded(async () => {
        if (event?.type !== "request_handoff") problem("CONTACT_NOT_ALLOWED");
        await read();
        // Explicit local handoff remains available without constructing either remote integration.
        await deps.handoffService.submitHandoff({ contact: event.contact, consent: true, reason: event.reason }, event.key);
        return read();
      }),
    };
    return { read, turn };
  }

  return {
    getView: () => operations.withConversationLock(owner.conversationId, () => session().read()),
    getAvailability: () => operations.withConversationLock(owner.conversationId, () => session().turn.listSlots()),
    async handleEvent(event, signal) {
      const validated = conversationEventSchema.parse(event);
      return operations.withConversationLock(owner.conversationId, async () => {
        throwIfAborted(signal);
        await prepareConversationGraph(pool);
        graph ??= buildConversationGraph(deps);
        const current = session(validated, signal);
        await runConversationGraph(graph, owner.conversationId, current.turn, signal);
        return current.read();
      });
    },
  };
}

/** Construct only the database/local capabilities; credentials are checked at the action boundary. */
export async function createConfiguredConversationService(owner: ConversationOwner): Promise<ConversationService> {
  const pool = getPool();
  const access = { ...owner };
  const getActiveRelease = () => createReleaseRepository(pool).getActiveRelease();
  let lead: LeadService | undefined;
  const getLeadService = () => {
    if (!lead) {
      try { lead = createLeadService({ pool, owner: access, hubspot: createHubSpotClient({ token: process.env.HUBSPOT_ACCESS_TOKEN ?? "" }), getActiveRelease }); }
      catch { throw Object.assign(new Error("CRM capability is not configured"), { code: "INTEGRATION_CONFIGURATION" }); }
    }
    return lead;
  };
  const getBookingService = async (): Promise<BookingService> => {
    const leadService = getLeadService();
    try {
      const calendar = await createConfiguredCalendarClient();
      return createBookingService({ pool, owner: access, calendar, calendarId: process.env.GOOGLE_CALENDAR_ID ?? "", leadService, getActiveRelease });
    } catch { throw Object.assign(new Error("Calendar capability is not configured"), { code: "INTEGRATION_CONFIGURATION" }); }
  };
  return createConversationService({
    pool, owner: access, getActiveRelease, retrieveContext: createContextRetriever({ pool }),
    extractLeadFacts, answerWithSources, getLeadService, getBookingService,
    handoffService: createHandoffService({ pool, owner: access, getActiveRelease }),
  });
}
