import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { createBookingService } from "../../src/server/booking/service";
import { createConversationRepository, type ConversationOwner } from "../../src/server/db/conversations";
import type { CalendarClient, CalendarEvent } from "../../src/server/integrations/google-calendar";
import { createLeadService } from "../../src/server/leads/crm";
import { startTestDatabase, type TestDatabase } from "./setup";

const now = () => new Date("2026-11-11T02:00:00Z");
const slot = {
  startUtc: "2026-11-12T02:00:00.000Z", endUtc: "2026-11-12T02:30:00.000Z",
  timeZone: "Asia/Ho_Chi_Minh" as const,
};
const getActiveRelease = async () => ({ releaseId: "demo-release", policy: DEFAULT_POLICY });
const hubspot = {
  findContactByEmail: async () => ({ id: "contact" }), createContact: async () => ({ id: "contact" }),
  createNote: async () => ({ id: "note" }), findNoteByMarker: async () => null,
  updateNote: async () => ({ id: "note" }),
};
let db: TestDatabase;

async function qualifiedOwner(): Promise<ConversationOwner> {
  const repo = createConversationRepository(db.pool);
  const conversation = await repo.createConversation();
  const owner = { conversationId: conversation.id, token: conversation.token };
  await repo.saveConversation({
    ...owner, state: {}, factsVersion: 1, policyVersion: DEFAULT_POLICY.version,
    facts: {
      service: "meta_ads", business: "Demo store", hasWebsite: true,
      budget: { kind: "total", totalMonthlyVnd: 15_000_000 }, startDate: "2026-12-01",
    },
  });
  await createLeadService({ pool: db.pool, owner, hubspot, getActiveRelease, now }).submitLead({
    contact: { name: "Demo", email: `${conversation.id}@example.com` }, consent: true, factsVersion: 1,
  }, "crm");
  return owner;
}

function createService(owner: ConversationOwner, calendar: CalendarClient) {
  const leadService = createLeadService({ pool: db.pool, owner, hubspot, getActiveRelease, now });
  return createBookingService({
    pool: db.pool, owner, calendar, calendarId: `${owner.conversationId}@group.calendar.google.com`,
    leadService, getActiveRelease, now,
  });
}

async function failureCount() {
  const result = await db.pool.query<{ count: string }>(
    "SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS count FROM test_booking_result_failures",
  );
  return Number(result.rows[0].count);
}

describe("DB result-write failure after acknowledged Calendar commit", () => {
  beforeAll(async () => {
    db = await startTestDatabase();
    // Real PostgreSQL failure on the second write of the success transaction:
    // bookings='booked' must roll back too. Sequence increments survive rollback,
    // proving this boundary actually fired, rather than a provider timeout.
    await db.pool.query(`
      CREATE TABLE test_booking_result_faults (conversation_id uuid PRIMARY KEY);
      CREATE SEQUENCE test_booking_result_failures;
      CREATE FUNCTION fail_test_booking_result() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.kind = 'booking' AND NEW.status = 'succeeded' AND EXISTS (
          SELECT 1 FROM test_booking_result_faults WHERE conversation_id = NEW.conversation_id
        ) THEN
          PERFORM nextval('test_booking_result_failures');
          RAISE EXCEPTION 'synthetic DB result-write failure after Calendar commit' USING ERRCODE = '58000';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER test_booking_result_write BEFORE UPDATE ON integration_operations
        FOR EACH ROW EXECUTE FUNCTION fail_test_booking_result();
    `);
  }, 120_000);
  afterAll(async () => { await db?.stop(); }, 30_000);

  // Distinct entry points: client replay, a new client key, explicit reconciliation.
  it.each(["same key", "new key", "reconcile"] as const)(
    "recovers through %s using the durable event ID, without a second insert",
    async recovery => {
      const owner = await qualifiedOwner();
      const events = new Map<string, CalendarEvent>();
      const reads: string[] = [];
      let inserts = 0;
      const calendar: CalendarClient = {
        freeBusy: async () => [],
        insertEvent: async input => {
          inserts++;
          const event: CalendarEvent = {
            id: input.eventId, startUtc: input.slot.startUtc, endUtc: input.slot.endUtc, status: "confirmed",
          };
          events.set(input.eventId, event);
          return event; // Successful acknowledgement, not a provider-side timeout.
        },
        getEvent: async id => { reads.push(id); return events.get(id) ?? null; },
      };
      await db.pool.query("INSERT INTO test_booking_result_faults VALUES ($1)", [owner.conversationId]);
      const failuresBefore = await failureCount();
      const confirmation = { startUtc: slot.startUtc, factsVersion: 1, confirmed: true as const };
      const result = await createService(owner, calendar).confirmBooking(confirmation, "confirm");
      expect(result).toMatchObject({ status: "unknown", operationId: expect.any(String) });
      if (result.status !== "unknown") throw new Error("Expected uncertain booking after DB failure");
      expect(await failureCount()).toBe(failuresBefore + 1);
      expect(inserts).toBe(1);
      expect(reads).toEqual([]);

      const snapshot = await db.pool.query(`
        SELECT b.event_id, b.status AS booking_status, o.status AS operation_status,
          o.external_ids->>'eventId' AS journal_event_id
        FROM bookings b JOIN integration_operations o ON o.id = b.operation_id
        WHERE b.operation_id = $1 AND b.conversation_id = $2
      `, [result.operationId, owner.conversationId]);
      expect(snapshot.rows).toEqual([{
        event_id: expect.any(String), journal_event_id: expect.any(String),
        booking_status: "pending", operation_status: "pending",
      }]);
      const eventId: string = snapshot.rows[0].event_id;
      expect(snapshot.rows[0].journal_event_id).toBe(eventId);
      expect([...events.keys()]).toEqual([eventId]);

      // Database becomes writable; build a fresh service (no previous request state).
      await db.pool.query("DELETE FROM test_booking_result_faults WHERE conversation_id = $1", [owner.conversationId]);
      const resumed = createService(owner, calendar);
      const booked = recovery === "reconcile"
        ? await resumed.reconcileBooking(result.operationId)
        : await resumed.confirmBooking(confirmation, recovery === "same key" ? "confirm" : "confirm-new");
      expect(booked).toEqual({ status: "booked", eventId, slot, crmSyncStatus: "succeeded" });
      expect(reads).toEqual([eventId]);
      expect(inserts).toBe(1);
      expect([...events.keys()]).toEqual([eventId]);
      const durable = await db.pool.query(`
        SELECT b.operation_id, b.event_id, b.status, b.crm_sync_status, o.status AS operation_status
        FROM bookings b JOIN integration_operations o ON o.id = b.operation_id
        WHERE b.conversation_id = $1
      `, [owner.conversationId]);
      expect(durable.rows).toEqual([{
        operation_id: result.operationId, event_id: eventId, status: "booked",
        crm_sync_status: "succeeded", operation_status: "succeeded",
      }]);
    },
  );
});
