import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { contactSchema } from "../../domain/contact";
import { agencyToday, policyForService } from "../../domain/policy";
import { leadFactsSchema, qualify } from "../../domain/qualification";
import type { Contact, LeadFacts, Slot, WriteStatus } from "../../domain/types";
import { assertConversationOwner, createConversationRepository, type ConversationOwner } from "../db/conversations";
import { createOperationRepository } from "../db/operations";
import { getPool, getQueryExecutor, withDatabaseConnection } from "../db/pool";
import { getActiveRelease, type ActiveRelease } from "../db/releases";
import { createHubSpotClient, type HubSpotClient } from "../integrations/hubspot";
import { createHandoffService, type HandoffInput } from "./handoff";

export type CrmSubmission = { status: "saved"; contactId: string; noteId: string } | { status: "partial"; contactId: string } | { status: "unknown"; operationId: string } | { status: "failed"; safeCode: string };
export interface SavedLead { contactId: string; noteId: string; contact: Contact; summary: string; factsVersion: number; policyVersion: string; consentId: string }
export interface LeadInput { contact: Contact; consent: true; factsVersion: number }
export interface CrmBookingInput { noteId: string; eventId: string; slot: Slot }
export interface LeadService {
  submitLead(input: LeadInput, key: string): Promise<CrmSubmission>;
  submitHandoff(input: HandoffInput, key: string): Promise<{ handoffId: string }>;
  getSavedLead(): Promise<SavedLead | null>;
  updateCrmBooking(input: CrmBookingInput, key: string): Promise<{ status: WriteStatus }>;
}
export interface LeadServiceOptions {
  pool: Pool; owner: ConversationOwner; hubspot: HubSpotClient;
  getActiveRelease: () => Promise<ActiveRelease>; now?: () => Date;
}
type LeadRow = {
  conversation_id: string; operation_id: string; consent_id: string; contact: Contact; summary: string;
  facts_version: string; policy_version: string; marker: string; status: "pending" | "saved" | "partial" | "unknown" | "failed";
  stage: "contact" | "note" | "complete"; contact_id: string | null; note_id: string | null; safe_error_code: string | null;
};
const inputSchema = z.object({ contact: contactSchema, consent: z.literal(true), factsVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict();
const bookingSchema = z.object({
  noteId: z.string().min(1).max(256), eventId: z.string().min(1).max(256),
  slot: z.object({ startUtc: z.iso.datetime({ offset: true }), endUtc: z.iso.datetime({ offset: true }), timeZone: z.literal("Asia/Ho_Chi_Minh") }).strict().refine(slot => Date.parse(slot.endUtc) > Date.parse(slot.startUtc)),
}).strict();
const keySchema = z.string().min(1).max(256);
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const problem = (code: string) => Object.assign(new Error(code), { code });
function remoteFailure(error: unknown): { outcome: "failed" | "unknown"; code: string } {
  const outcome = error !== null && typeof error === "object" && "outcome" in error ? error.outcome : undefined;
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  const suffix = typeof code === "string" ? code.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 110) : "UNKNOWN";
  return { outcome: outcome === "failed" ? "failed" : "unknown", code: `CRM_${suffix}` };
}
function submission(row: LeadRow): CrmSubmission {
  if (row.status === "saved" && row.contact_id && row.note_id) return { status: "saved", contactId: row.contact_id, noteId: row.note_id };
  if (row.status === "partial" && row.contact_id) return { status: "partial", contactId: row.contact_id };
  if (row.status === "failed") return { status: "failed", safeCode: row.safe_error_code ?? "CRM_FAILED" };
  return { status: "unknown", operationId: row.operation_id };
}
function summaryFor(contact: Contact, facts: LeadFacts, release: ActiveRelease): string {
  // Only validated, explicitly consented contact and qualification facts; never the transcript.
  const budget = facts.budget.kind === "total" ? `Total monthly VND: ${facts.budget.totalMonthlyVnd}`
    : facts.budget.kind === "media_only" ? `Media monthly VND: ${facts.budget.mediaMonthlyVnd}; accepts management fee: ${facts.budget.acceptsManagementFee}`
    : facts.budget.kind === "split" ? `Media monthly VND: ${facts.budget.mediaMonthlyVnd}; management monthly VND: ${facts.budget.managementMonthlyVnd}` : "Unknown";
  return [`LeadDesk qualified lead`, `Name: ${contact.name}`, `Email: ${contact.email}`, ...(contact.phone ? [`Phone: ${contact.phone}`] : []),
    `Business: ${facts.business}`, `Service: ${facts.service ? policyForService(release.policy, facts.service).title : ""}`,
    `Website: ${facts.hasWebsite}`, budget, `Start date: ${facts.startDate}`, `Policy: ${release.policy.version}`].join("\n");
}
async function readLead(pool: Pool, conversationId: string): Promise<LeadRow | null> {
  return (await getQueryExecutor(pool).query<LeadRow>("SELECT * FROM lead_submissions WHERE conversation_id=$1", [conversationId])).rows[0] ?? null;
}
async function transaction<T>(pool: Pool, action: () => Promise<T>): Promise<T> {
  const executor = getQueryExecutor(pool);
  await executor.query("BEGIN");
  try { const result = await action(); await executor.query("COMMIT"); return result; }
  catch (error) { await executor.query("ROLLBACK"); throw error; }
}
async function recordResult(pool: Pool, row: LeadRow, status: LeadRow["status"], code: string | null, contactId = row.contact_id, noteId = row.note_id): Promise<CrmSubmission> {
  return transaction(pool, async () => {
    const executor = getQueryExecutor(pool);
    const result = await executor.query<LeadRow>(
      `UPDATE lead_submissions SET status=$2,safe_error_code=$3,contact_id=$4,note_id=$5,
       stage=CASE WHEN $2='saved' THEN 'complete' ELSE stage END,updated_at=now() WHERE conversation_id=$1 RETURNING *`,
      [row.conversation_id, status, code, contactId, noteId],
    );
    const ids = { ...(contactId ? { contactId } : {}), ...(noteId ? { noteId } : {}) };
    await executor.query(
      "UPDATE integration_operations SET status=$2,safe_error_code=$3,external_ids=external_ids || $4::jsonb,updated_at=now() WHERE id=$1 AND conversation_id=$5",
      [row.operation_id, status === "saved" ? "succeeded" : status === "pending" || status === "unknown" ? "unknown" : "failed", code, JSON.stringify(ids), row.conversation_id],
    );
    return submission(result.rows[0]);
  });
}
async function recordContact(pool: Pool, row: LeadRow, contactId: string): Promise<void> {
  await transaction(pool, async () => {
    const executor = getQueryExecutor(pool);
    await executor.query("UPDATE lead_submissions SET contact_id=$2,stage='note',updated_at=now() WHERE conversation_id=$1", [row.conversation_id, contactId]);
    await executor.query("UPDATE integration_operations SET external_ids=external_ids || $2::jsonb,updated_at=now() WHERE id=$1", [row.operation_id, JSON.stringify({ contactId })]);
  });
  row.contact_id = contactId;
  row.stage = "note";
}
async function createLeadNote(pool: Pool, hubspot: HubSpotClient, row: LeadRow): Promise<CrmSubmission> {
  try {
    const note = row.note_id
      ? await hubspot.updateNote(row.note_id, `${row.summary}\n${row.marker}`)
      : await hubspot.createNote({ contactId: row.contact_id!, body: row.summary, marker: row.marker });
    if (row.note_id && note.id !== row.note_id) throw Object.assign(new Error("Note identity mismatch"), { code: "invalid_response", outcome: "unknown" });
    return await recordResult(pool, row, "saved", null, row.contact_id, note.id);
  } catch (error) {
    const failure = remoteFailure(error);
    return recordResult(pool, row, failure.outcome === "unknown" ? "unknown" : row.note_id ? "failed" : "partial", failure.code);
  }
}

export function createLeadService(options: LeadServiceOptions): LeadService {
  const { pool, hubspot, getActiveRelease: activeRelease } = options;
  const owner = { ...options.owner };
  const now = options.now ?? (() => new Date());
  const operations = createOperationRepository(pool, owner);
  const conversations = createConversationRepository(pool);
  const handoff = createHandoffService({ pool, owner, getActiveRelease: activeRelease });
  return {
    submitHandoff: handoff.submitHandoff,
    async submitLead(input, key) {
      const value = inputSchema.parse(input);
      keySchema.parse(key);
      return operations.withConversationLock(owner.conversationId, async () => {
        const conversation = await conversations.getConversation(owner);
        if (conversation.factsValidationPending) throw problem("FACTS_VALIDATION_PENDING");
        const release = await activeRelease();
        if (conversation.factsVersion !== value.factsVersion) throw problem("STALE_FACTS");
        if (conversation.policyVersion !== release.policy.version) throw problem("STALE_POLICY");
        const facts = leadFactsSchema.parse(conversation.facts);
        if (qualify(facts, release.policy, agencyToday(now())).status !== "qualified") throw problem("LEAD_NOT_QUALIFIED");
        const row = await transaction(pool, async () => {
          const claim = await operations.claimOperation({ conversationId: owner.conversationId, kind: "crm", key, payloadHash: digest(value) });
          const existing = await readLead(pool, owner.conversationId);
          const changed = existing && (Number(existing.facts_version) !== value.factsVersion
            || existing.policy_version !== release.policy.version || JSON.stringify(existing.contact) !== JSON.stringify(value.contact));
          if (existing && claim.created && existing.status !== "pending" && existing.status !== "unknown" && (changed || existing.status === "failed")) {
            const executor = getQueryExecutor(pool);
            const consent = await executor.query<{ id: string }>("INSERT INTO consents(conversation_id,purpose,granted,facts_version,policy_version) VALUES($1,'crm',true,$2,$3) RETURNING id", [owner.conversationId, value.factsVersion, release.policy.version]);
            const sameContact = existing.contact.email === value.contact.email;
            const refreshed = await executor.query<LeadRow>(
              `UPDATE lead_submissions SET operation_id=$2,consent_id=$3,contact=$4::jsonb,summary=$5,
               facts_version=$6,policy_version=$7,marker=$8,status='pending',safe_error_code=NULL,
               contact_id=$9,note_id=$10,stage=CASE WHEN $9::text IS NULL THEN 'contact' ELSE 'note' END,updated_at=now()
               WHERE conversation_id=$1 RETURNING *`,
              [owner.conversationId, claim.operation.id, consent.rows[0].id, JSON.stringify(value.contact), summaryFor(value.contact, facts, release),
                value.factsVersion, release.policy.version, `leaddesk:operation:${claim.operation.id}`,
                sameContact ? existing.contact_id : null, sameContact ? existing.note_id : null],
            );
            return { row: refreshed.rows[0], created: true };
          }
          if (existing) {
            if (claim.created) {
              const result = submission(existing);
              await operations.finishOperation(claim.operation.id, {
                status: result.status === "saved" ? "succeeded" : result.status === "unknown" ? "unknown" : "failed",
                safeErrorCode: result.status === "saved" ? null : existing.safe_error_code ?? "CRM_CANONICAL_PENDING",
                externalIds: { canonicalOperationId: existing.operation_id, ...(existing.contact_id ? { contactId: existing.contact_id } : {}), ...(existing.note_id ? { noteId: existing.note_id } : {}) },
              });
            }
            return { row: existing, created: false };
          }
          if (!claim.created) throw problem("CRM_JOURNAL_INCONSISTENT");
          const executor = getQueryExecutor(pool);
          const consent = await executor.query<{ id: string }>("INSERT INTO consents(conversation_id,purpose,granted,facts_version,policy_version) VALUES($1,'crm',true,$2,$3) RETURNING id", [owner.conversationId, value.factsVersion, release.policy.version]);
          const inserted = await executor.query<LeadRow>(
            `INSERT INTO lead_submissions(conversation_id,operation_id,consent_id,contact,summary,facts_version,policy_version,marker)
             VALUES($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`,
            [owner.conversationId, claim.operation.id, consent.rows[0].id, JSON.stringify(value.contact), summaryFor(value.contact, facts, release), value.factsVersion, release.policy.version, `leaddesk:operation:${claim.operation.id}`],
          );
          return { row: inserted.rows[0], created: true };
        });
        if (!row.created) return submission(row.row);
        try {
          let contact = await hubspot.findContactByEmail(value.contact.email);
          if (!contact) {
            try { contact = await hubspot.createContact(value.contact); }
            catch (error) {
              if (error === null || typeof error !== "object" || !("code" in error) || error.code !== "conflict") throw error;
              // A duplicate rejection is authoritative that creation must not be retried.
              try { contact = await hubspot.findContactByEmail(value.contact.email); }
              catch { throw Object.assign(new Error("Contact reconciliation unavailable"), { outcome: "unknown", code: "conflict_unresolved" }); }
              if (!contact) throw Object.assign(new Error("Contact reconciliation pending"), { outcome: "unknown", code: "conflict_unresolved" });
            }
          }
          await recordContact(pool, row.row, contact.id);
        } catch (error) {
          const failure = remoteFailure(error);
          return recordResult(pool, row.row, failure.outcome === "unknown" ? "unknown" : "failed", failure.code);
        }
        return createLeadNote(pool, hubspot, row.row);
      });
    },
    async getSavedLead() {
      await assertConversationOwner(getQueryExecutor(pool), owner);
      const row = await readLead(pool, owner.conversationId);
      if (!row || row.status !== "saved" || !row.contact_id || !row.note_id) return null;
      return { contactId: row.contact_id, noteId: row.note_id, contact: row.contact, summary: row.summary, factsVersion: Number(row.facts_version), policyVersion: row.policy_version, consentId: row.consent_id };
    },
    updateCrmBooking: bookingUpdater({ pool, conversationId: owner.conversationId, hubspot, authorize: () => assertConversationOwner(getQueryExecutor(pool), owner) }),
  };
}

function assertAdmin(adminId: string): void {
  const configured = process.env.ADMIN_USER_ID;
  if (!configured || !z.string().uuid().safeParse(adminId).success || adminId !== configured) throw problem("ADMIN_UNAUTHORIZED");
}
function bookingUpdater(options: { pool: Pool; conversationId: string; hubspot: HubSpotClient; authorize: () => Promise<void> }): LeadService["updateCrmBooking"] {
  return async (input, key) => {
    const value = bookingSchema.parse(input);
    keySchema.parse(key);
    await options.authorize();
    const { pool, conversationId, hubspot } = options;
    const executor = getQueryExecutor(pool);
    const row = await readLead(pool, conversationId);
    if (!row || row.status !== "saved" || row.note_id !== value.noteId) throw problem("CRM_LEAD_NOT_SAVED");
    const hash = digest(value);
    const claim = await executor.query<{ id: string; payload_hash: string; status: WriteStatus }>(
      `INSERT INTO integration_operations(conversation_id,kind,key,payload_hash) VALUES($1,'crm_booking_update',$2,$3)
       ON CONFLICT(conversation_id,kind,key) DO NOTHING RETURNING id,payload_hash,status`, [conversationId, key, hash],
    );
    const operation = claim.rows[0] ?? (await executor.query<{ id: string; payload_hash: string; status: WriteStatus }>("SELECT id,payload_hash,status FROM integration_operations WHERE conversation_id=$1 AND kind='crm_booking_update' AND key=$2", [conversationId, key])).rows[0];
    if (!operation || operation.payload_hash !== hash) throw problem("OPERATION_PAYLOAD_CONFLICT");
    if (!claim.rowCount) return { status: operation.status === "pending" ? "unknown" : operation.status };
    let status: WriteStatus = "succeeded";
    let code: string | null = null;
    try {
      const result = await hubspot.updateNote(value.noteId, `${row.summary}\n${row.marker}\nBooking confirmed\nEvent: ${value.eventId}\nStart: ${value.slot.startUtc}\nEnd: ${value.slot.endUtc}\nTime zone: ${value.slot.timeZone}`);
      if (result.id !== value.noteId) throw Object.assign(new Error("Note identity mismatch"), { code: "invalid_response", outcome: "unknown" });
    } catch (error) { const failure = remoteFailure(error); status = failure.outcome; code = failure.code; }
    await executor.query("UPDATE integration_operations SET status=$2,safe_error_code=$3,external_ids=$4::jsonb,updated_at=now() WHERE id=$1", [operation.id, status, code, JSON.stringify({ noteId: value.noteId, eventId: value.eventId })]);
    return { status };
  };
}

/** Call only after the HTTP boundary verifies Supabase identity. No visitor-token bypass is exposed. */
export function createAdminCrmUpdater(options: { pool: Pool; adminId: string; hubspot: HubSpotClient; conversationId: string }): Pick<LeadService, "updateCrmBooking"> {
  const { pool, adminId, hubspot } = options;
  const conversationId = z.string().uuid().parse(options.conversationId);
  assertAdmin(adminId);
  return { updateCrmBooking: bookingUpdater({ pool, conversationId, hubspot, authorize: async () => {
    assertAdmin(adminId);
    if (!(await getQueryExecutor(pool).query("SELECT id FROM conversations WHERE id=$1", [conversationId])).rowCount) throw problem("CONVERSATION_NOT_FOUND");
  } }) };
}

export interface CrmReconcilerOptions { pool: Pool; hubspot: HubSpotClient; getActiveRelease: () => Promise<ActiveRelease>; now?: () => Date }
/** Internal admin SQL is gated by the configured allowlist; routes must additionally verify Supabase. */
export function createCrmReconciler(options: CrmReconcilerOptions): { reconcileCrm(operationId: string, adminId: string): Promise<CrmSubmission> } {
  return { async reconcileCrm(operationId, adminId) {
    assertAdmin(adminId);
    z.string().uuid().parse(operationId);
    const { pool, hubspot } = options;
    const client = await pool.connect();
    let locked = false;
    let discard = false;
    let lockKey = "";
    try {
      const operation = await client.query<{ conversation_id: string }>("SELECT conversation_id FROM integration_operations WHERE id=$1 AND kind='crm'", [operationId]);
      if (!operation.rowCount) throw problem("CRM_OPERATION_NOT_FOUND");
      const conversationId = operation.rows[0].conversation_id;
      lockKey = createHash("sha256").update(conversationId.toLowerCase()).digest().readBigInt64BE().toString();
      try { locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockKey])).rows[0].locked; }
      catch (error) { discard = true; throw error; }
      if (!locked) throw problem("CONVERSATION_BUSY");
      return await withDatabaseConnection(pool, client, async () => {
        const row = await readLead(pool, conversationId);
        if (!row) throw problem("CRM_OPERATION_NOT_FOUND");
        if (row.status === "saved") return submission(row);
        const contact = row.contact_id ? { id: row.contact_id } : await hubspot.findContactByEmail(row.contact.email);
        if (contact) {
          if (!row.contact_id) await recordContact(pool, row, contact.id);
          const note = await hubspot.findNoteByMarker({ contactId: contact.id, marker: row.marker });
          if (note) return recordResult(pool, row, "saved", null, contact.id, note.id);
        }
        // Empty searches are not proof that an uncertain write never committed (indexing can lag).
        if (row.status !== "partial" || !contact) return submission(row);
        const consent = await client.query<{ facts_version: string; policy_version: string; granted: boolean; facts: unknown; current_version: string; current_policy: string | null; validation_pending: boolean }>(
          `SELECT s.facts_version,s.policy_version,s.granted,c.facts,c.facts_version AS current_version,c.policy_version AS current_policy,c.facts_validation_pending AS validation_pending
           FROM consents s JOIN conversations c ON c.id=s.conversation_id WHERE s.id=$1 AND s.conversation_id=$2 AND s.purpose='crm'`, [row.consent_id, conversationId],
        );
        const authorization = consent.rows[0];
        const release = await options.getActiveRelease();
        if (!authorization?.granted || authorization.validation_pending || Number(authorization.facts_version) !== Number(row.facts_version)
          || Number(authorization.current_version) !== Number(row.facts_version) || authorization.policy_version !== row.policy_version
          || authorization.current_policy !== release.policy.version || release.policy.version !== row.policy_version
          || qualify(leadFactsSchema.parse(authorization.facts), release.policy, agencyToday(options.now?.() ?? new Date())).status !== "qualified") throw problem("CRM_RECONCILIATION_STALE");
        // Only an explicitly rejected Note can be retried after read-first reconciliation.
        // Persist the transition before the write so a lost retry response cannot be retried again.
        await recordResult(pool, row, "unknown", "CRM_RECONCILING");
        row.status = "unknown";
        return createLeadNote(pool, hubspot, row);
      });
    } finally {
      try {
        if (locked) {
          try { if (!(await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockKey])).rows[0].unlocked) { discard = true; throw problem("CRM_LOCK_RELEASE_FAILED"); } }
          catch (error) { discard = true; throw error; }
        }
      } finally { client.release(discard); }
    }
  } };
}

export function reconcileCrm(operationId: string, adminId: string): Promise<CrmSubmission> {
  assertAdmin(adminId);
  return createCrmReconciler({ pool: getPool(), hubspot: createHubSpotClient({ token: process.env.HUBSPOT_ACCESS_TOKEN ?? "" }), getActiveRelease }).reconcileCrm(operationId, adminId);
}

export interface CrmBookingReconciler {
  reconcileCrmBooking(operationId: string, adminId: string): Promise<{ status: WriteStatus }>;
}

export function createCrmBookingReconciler(options: { pool: Pool; hubspot: HubSpotClient }): CrmBookingReconciler {
  return { async reconcileCrmBooking(operationId, adminId) {
    assertAdmin(adminId);
    z.string().uuid().parse(operationId);
    const client = await options.pool.connect();
    let locked = false;
    let discard = false;
    let lockKey = "";
    try {
      const found = await client.query<{ conversation_id: string; status: WriteStatus; payload_hash: string }>(
        "SELECT conversation_id,status,payload_hash FROM integration_operations WHERE id=$1 AND kind='crm_booking_update'", [operationId]);
      const operation = found.rows[0];
      if (!operation) throw problem("CRM_OPERATION_NOT_FOUND");
      lockKey = createHash("sha256").update(operation.conversation_id.toLowerCase()).digest().readBigInt64BE().toString();
      try { locked = (await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [lockKey])).rows[0].locked; }
      catch (error) { discard = true; throw error; }
      if (!locked) throw problem("CONVERSATION_BUSY");
      return await withDatabaseConnection(options.pool, client, async () => {
        const lead = await readLead(options.pool, operation.conversation_id);
        const booked = await client.query<{ event_id: string; start_utc: Date; end_utc: Date; time_zone: "Asia/Ho_Chi_Minh"; note_id: string }>(
          "SELECT event_id,start_utc,end_utc,time_zone,note_id FROM bookings WHERE conversation_id=$1 AND status='booked'", [operation.conversation_id]);
        const booking = booked.rows[0];
        if (!lead?.contact_id || !lead.note_id || !booking || booking.note_id !== lead.note_id) throw problem("CRM_BOOKING_NOT_CONFIRMED");
        const input: CrmBookingInput = { noteId: lead.note_id, eventId: booking.event_id,
          slot: { startUtc: booking.start_utc.toISOString(), endUtc: booking.end_utc.toISOString(), timeZone: booking.time_zone } };
        if (operation.payload_hash !== digest(input)) throw problem("OPERATION_PAYLOAD_CONFLICT");
        const note = await options.hubspot.findNoteByMarker({ contactId: lead.contact_id, marker: lead.marker });
        if (!note || note.id !== lead.note_id) return { status: operation.status === "succeeded" ? "succeeded" : "unknown" };
        const body = note.body.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
        const alreadyApplied = [lead.marker, `Event: ${input.eventId}`, `Start: ${input.slot.startUtc}`, `End: ${input.slot.endUtc}`].every(value => body.includes(value));
        if (!alreadyApplied) return { status: operation.status === "failed" ? "failed" : "unknown" };
        await client.query("BEGIN");
        try {
          await client.query("UPDATE integration_operations SET status='succeeded',safe_error_code=NULL,external_ids=external_ids || $2::jsonb,updated_at=now() WHERE id=$1", [operationId, JSON.stringify({ noteId: lead.note_id, eventId: booking.event_id })]);
          await client.query("UPDATE bookings SET crm_sync_status='succeeded',updated_at=now() WHERE conversation_id=$1 AND event_id=$2", [operation.conversation_id, booking.event_id]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        return { status: "succeeded" };
      });
    } finally {
      try {
        if (locked) {
          try { if (!(await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockKey])).rows[0].unlocked) { discard = true; throw problem("CRM_LOCK_RELEASE_FAILED"); } }
          catch (error) { discard = true; throw error; }
        }
      } finally { client.release(discard); }
    }
  } };
}

export function reconcileCrmBooking(operationId: string, adminId: string): Promise<{ status: WriteStatus }> {
  assertAdmin(adminId);
  return createCrmBookingReconciler({ pool: getPool(), hubspot: createHubSpotClient({ token: process.env.HUBSPOT_ACCESS_TOKEN ?? "" }) }).reconcileCrmBooking(operationId, adminId);
}
