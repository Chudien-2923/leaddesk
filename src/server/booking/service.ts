import "server-only";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { computeSlots } from "../../domain/booking-slots";
import { leadFactsSchema, qualify } from "../../domain/qualification";
import { agencyToday, type AgencyPolicy } from "../../domain/policy";
import type { Slot, WriteStatus } from "../../domain/types";
import { createConversationRepository, type ConversationOwner } from "../db/conversations";
import { createOperationRepository } from "../db/operations";
import { getQueryExecutor } from "../db/pool";
import type { CalendarClient, CalendarEvent } from "../integrations/google-calendar";
import type { LeadService } from "../leads/crm";

export type BookingResult =
  | { status: "booked"; eventId: string; slot: Slot; crmSyncStatus: WriteStatus }
  | { status: "slot_unavailable" | "stale" }
  | { status: "unknown"; operationId: string }
  | { status: "failed"; safeCode: string };
export interface BookingService {
  listSlots(): Promise<Slot[]>;
  confirmBooking(input: { startUtc: string; factsVersion: number; confirmed: true }, key: string): Promise<BookingResult>;
  reconcileBooking(operationId: string): Promise<BookingResult>;
}
export interface BookingRecoveryDependencies {
  pool: Pool;
  calendar: CalendarClient;
  calendarId: string;
  leadService: Pick<LeadService, "updateCrmBooking">;
}
interface BookingRow {
  operation_id: string; conversation_id: string; calendar_id: string; event_id: string;
  start_utc: Date; end_utc: Date; time_zone: "Asia/Ho_Chi_Minh"; note_id: string;
  status: "pending" | "unknown" | "booked" | "failed" | "cancelled";
  crm_sync_status: WriteStatus;
  safe_error_code?: string | null;
}
const confirmSchema = z.object({ startUtc: z.iso.datetime({ offset: true }), factsVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), confirmed: z.literal(true) }).strict();
const keySchema = z.string().min(1).max(256);

async function recordFailure(pool: Pool, row: BookingRow, safeCode: string, cancelled = false): Promise<void> {
  const executor = getQueryExecutor(pool);
  await executor.query("BEGIN");
  try {
    await executor.query("UPDATE bookings SET status = $2, updated_at = now() WHERE operation_id = $1", [row.operation_id, cancelled ? "cancelled" : "failed"]);
    await executor.query("UPDATE integration_operations SET status = 'failed', safe_error_code = $2, updated_at = now() WHERE id = $1 AND status <> 'succeeded'", [row.operation_id, safeCode]);
    await executor.query("COMMIT");
  } catch (error) { await executor.query("ROLLBACK"); throw error; }
}

async function finishConfirmed(deps: BookingRecoveryDependencies, row: BookingRow, event: CalendarEvent): Promise<BookingResult> {
  if (event.id !== row.event_id) return { status: "unknown", operationId: row.operation_id };
  if (event.status === "cancelled") {
    await recordFailure(deps.pool, row, "CALENDAR_CANCELLED", true);
    return { status: "failed", safeCode: "CALENDAR_CANCELLED" };
  }
  const slot: Slot = { startUtc: new Date(row.start_utc).toISOString(), endUtc: new Date(row.end_utc).toISOString(), timeZone: row.time_zone };
  if (event.status !== "confirmed" || Date.parse(event.startUtc) !== Date.parse(slot.startUtc) || Date.parse(event.endUtc) !== Date.parse(slot.endUtc)) return { status: "unknown", operationId: row.operation_id };
  const executor = getQueryExecutor(deps.pool);
  // Record Calendar success before attempting the independent CRM side effect.
  await executor.query("BEGIN");
  try {
    await executor.query("UPDATE bookings SET status = 'booked', updated_at = now() WHERE operation_id = $1", [row.operation_id]);
    await executor.query("UPDATE integration_operations SET status = 'succeeded', safe_error_code = NULL, external_ids = external_ids || $2::jsonb, updated_at = now() WHERE id = $1", [row.operation_id, JSON.stringify({ eventId: row.event_id })]);
    await executor.query("COMMIT");
  } catch (error) { await executor.query("ROLLBACK"); throw error; }
  let crmSyncStatus = row.crm_sync_status;
  if (crmSyncStatus !== "succeeded") {
    try {
      crmSyncStatus = (await deps.leadService.updateCrmBooking({ noteId: row.note_id, eventId: row.event_id, slot }, `booking:${row.operation_id}`)).status;
    } catch { crmSyncStatus = "unknown"; }
    await executor.query("UPDATE bookings SET crm_sync_status = $2, updated_at = now() WHERE operation_id = $1", [row.operation_id, crmSyncStatus]);
  }
  return { status: "booked", eventId: row.event_id, slot, crmSyncStatus };
}

// Caller must hold the conversation session lock and authorize the owner or verified admin.
export async function recoverExistingBooking(deps: BookingRecoveryDependencies, operationId: string, conversationId: string): Promise<BookingResult> {
  z.string().uuid().parse(operationId);
  const result = await getQueryExecutor(deps.pool).query<BookingRow>("SELECT b.*, o.safe_error_code FROM bookings b JOIN integration_operations o ON o.id = b.operation_id AND o.conversation_id = b.conversation_id WHERE b.operation_id = $1 AND b.conversation_id = $2 AND b.calendar_id = $3", [operationId, conversationId, deps.calendarId]);
  const row = result.rows[0];
  if (!row) throw Object.assign(new Error("Booking access denied"), { code: "OPERATION_FORBIDDEN" });
  if (row.status === "cancelled") return { status: "failed", safeCode: "CALENDAR_CANCELLED" };
  if (row.status === "failed") {
    if (row.safe_error_code === "BOOKING_STALE") return { status: "stale" };
    if (row.safe_error_code === "SLOT_UNAVAILABLE") return { status: "slot_unavailable" };
    return { status: "failed", safeCode: row.safe_error_code ?? "CALENDAR_REJECTED" };
  }
  try {
    const event = await deps.calendar.getEvent(row.event_id);
    // A single absence read does not prove a timed-out write can never become visible.
    if (!event) return { status: "unknown", operationId };
    return await finishConfirmed(deps, row, event);
  } catch { return { status: "unknown", operationId }; }
}

export function createBookingService(options: BookingRecoveryDependencies & {
  owner: ConversationOwner;
  leadService: LeadService;
  getActiveRelease: () => Promise<{ releaseId: string; policy: AgencyPolicy }>;
  now?: () => Date;
}): BookingService {
  const { pool, calendar, calendarId, leadService, getActiveRelease, now = () => new Date() } = options;
  if (!calendarId?.trim() || calendarId.trim().toLowerCase() === "primary" || calendarId.trim() !== calendarId) throw Object.assign(new Error("Dedicated calendar required"), { code: "CALENDAR_CONFIGURATION" });
  const owner = { ...options.owner };
  const conversations = createConversationRepository(pool);
  const operations = createOperationRepository(pool, owner);
  const deps = { pool, calendar, calendarId, leadService };
  async function eligible(factsVersion?: number) {
    const conversation = await conversations.getConversation(owner);
    if (conversation.factsValidationPending) return null;
    const release = await getActiveRelease();
    const saved = await leadService.getSavedLead();
    const facts = leadFactsSchema.safeParse(conversation.facts);
    const today = agencyToday(now());
    if (!saved || !facts.success || conversation.factsVersion !== saved.factsVersion || (factsVersion !== undefined && factsVersion !== conversation.factsVersion) || conversation.policyVersion !== release.policy.version || saved.policyVersion !== release.policy.version || qualify(facts.data, release.policy, today).status !== "qualified") return null;
    const consent = await getQueryExecutor(pool).query("SELECT id FROM consents WHERE id = $1 AND conversation_id = $2 AND granted AND facts_version = $3 AND policy_version = $4", [saved.consentId, owner.conversationId, conversation.factsVersion, release.policy.version]);
    return consent.rowCount ? { conversation, release, saved } : null;
  }
  return {
    async listSlots() {
      const state = await eligible();
      if (!state) return [];
      const clock = now();
      try {
        const busy = await calendar.freeBusy({ startUtc: clock.toISOString(), endUtc: new Date(clock.getTime() + state.release.policy.booking.horizonDays * 86_400_000).toISOString() });
        const reserved = await getQueryExecutor(pool).query<{ start_utc: Date; end_utc: Date }>("SELECT start_utc, end_utc FROM bookings WHERE calendar_id = $1 AND status IN ('pending', 'unknown', 'booked') AND end_utc > $2", [calendarId, clock]);
        return computeSlots({ now: clock, policy: state.release.policy, busy: [...busy, ...reserved.rows.map(row => ({ startUtc: row.start_utc.toISOString(), endUtc: row.end_utc.toISOString() }))] });
      } catch {
        throw Object.assign(new Error("Calendar availability could not be verified"), { code: "CALENDAR_AVAILABILITY_UNAVAILABLE" });
      }
    },
    async confirmBooking(input, key) {
      const value = confirmSchema.parse(input);
      keySchema.parse(key);
      const startUtc = new Date(value.startUtc).toISOString();
      const payloadHash = createHash("sha256").update(JSON.stringify({ startUtc, factsVersion: value.factsVersion, confirmed: true })).digest("hex");
      return operations.withConversationLock(owner.conversationId, async (): Promise<BookingResult> => {
        const executor = getQueryExecutor(pool);
        const previous = await executor.query<{ id: string; payload_hash: string }>("SELECT id, payload_hash FROM integration_operations WHERE conversation_id = $1 AND kind = 'booking' AND key = $2", [owner.conversationId, key]);
        if (previous.rows[0] && previous.rows[0].payload_hash !== payloadHash) throw Object.assign(new Error("Operation key has a different payload"), { code: "OPERATION_PAYLOAD_CONFLICT" });
        const logical = await executor.query<BookingRow>("SELECT * FROM bookings WHERE conversation_id = $1 AND status IN ('pending', 'unknown', 'booked')", [owner.conversationId]);
        if (logical.rows[0]) return recoverExistingBooking(deps, logical.rows[0].operation_id, owner.conversationId);
        if (previous.rows[0]) {
          const old = await executor.query<BookingRow>("SELECT * FROM bookings WHERE operation_id = $1", [previous.rows[0].id]);
          return old.rows[0] ? recoverExistingBooking(deps, previous.rows[0].id, owner.conversationId) : { status: "slot_unavailable" };
        }
        const state = await eligible(value.factsVersion);
        if (!state) return { status: "stale" };
        const clock = now();
        const slot = computeSlots({ now: clock, busy: [], policy: state.release.policy }).find(candidate => candidate.startUtc === startUtc);
        if (!slot) return { status: "slot_unavailable" };
        let row: BookingRow | undefined;
        await executor.query("BEGIN");
        try {
          const claim = await operations.claimOperation({ conversationId: owner.conversationId, kind: "booking", key, payloadHash });
          const eventId = claim.operation.id.replaceAll("-", "");
          const consent = await executor.query<{ id: string }>("INSERT INTO consents (conversation_id, purpose, granted, facts_version, policy_version) VALUES ($1, 'booking', true, $2, $3) RETURNING id", [owner.conversationId, value.factsVersion, state.release.policy.version]);
          const reservation = await executor.query<BookingRow>(`INSERT INTO bookings (conversation_id, operation_id, consent_id, calendar_id, event_id, start_utc, end_utc, time_zone, facts_version, policy_version, note_id)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING RETURNING *`, [owner.conversationId, claim.operation.id, consent.rows[0].id, calendarId, eventId, slot.startUtc, slot.endUtc, slot.timeZone, value.factsVersion, state.release.policy.version, state.saved.noteId]);
          row = reservation.rows[0];
          if (!row) await executor.query("UPDATE integration_operations SET status = 'failed', safe_error_code = 'SLOT_UNAVAILABLE', updated_at = now() WHERE id = $1", [claim.operation.id]);
          else await executor.query("UPDATE integration_operations SET external_ids = $2::jsonb WHERE id = $1", [claim.operation.id, JSON.stringify({ eventId })]);
          await executor.query("COMMIT");
        } catch (error) { await executor.query("ROLLBACK"); throw error; }
        if (!row) return { status: "slot_unavailable" };
        // No transaction remains open while reaching the external provider.
        try {
          const busy = await calendar.freeBusy({ startUtc: slot.startUtc, endUtc: slot.endUtc });
          if (!computeSlots({ now: now(), busy, policy: state.release.policy }).some(candidate => candidate.startUtc === slot.startUtc)) {
            await recordFailure(pool, row, "SLOT_UNAVAILABLE");
            return { status: "slot_unavailable" };
          }
        } catch {
          // Availability failed before event dispatch: retain the audit row, release only this certainly unwritten reservation.
          try { await recordFailure(pool, row, "CALENDAR_AVAILABILITY_UNAVAILABLE"); }
          catch { return { status: "unknown", operationId: row.operation_id }; }
          return { status: "failed", safeCode: "CALENDAR_AVAILABILITY_UNAVAILABLE" };
        }
        const current = await eligible(value.factsVersion);
        if (!current || current.release.policy.version !== state.release.policy.version) {
          try { await recordFailure(pool, row, "BOOKING_STALE"); }
          catch { return { status: "unknown", operationId: row.operation_id }; }
          return { status: "stale" };
        }
        let event: CalendarEvent;
        try {
          event = await calendar.insertEvent({ eventId: row.event_id, slot, summary: "LeadDesk discovery call" });
        } catch (error) {
          const failure = error as { outcome?: string; code?: string };
          if (failure.code === "conflict") return recoverExistingBooking(deps, row.operation_id, owner.conversationId);
          if (failure.outcome === "failed") {
            try { await recordFailure(pool, row, "CALENDAR_REJECTED"); } catch { return { status: "unknown", operationId: row.operation_id }; }
            return { status: "failed", safeCode: "CALENDAR_REJECTED" };
          }
          try { await executor.query("UPDATE bookings SET status = 'unknown', updated_at = now() WHERE operation_id = $1", [row.operation_id]); await executor.query("UPDATE integration_operations SET status = 'unknown', safe_error_code = 'CALENDAR_UNCERTAIN', updated_at = now() WHERE id = $1 AND status = 'pending'", [row.operation_id]); } catch { /* Durable pending reservation still prevents a second insert. */ }
          return { status: "unknown", operationId: row.operation_id };
        }
        try { return await finishConfirmed(deps, row, event); }
        catch { return { status: "unknown", operationId: row.operation_id }; }
      });
    },
    async reconcileBooking(operationId) {
      return operations.withConversationLock(owner.conversationId, async (): Promise<BookingResult> => {
        const operation = await operations.getOperation(operationId);
        if (operation.kind !== "booking") throw Object.assign(new Error("Booking access denied"), { code: "OPERATION_FORBIDDEN" });
        return recoverExistingBooking(deps, operationId, owner.conversationId);
      });
    },
  };
}
