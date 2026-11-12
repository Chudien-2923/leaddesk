import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { createConversationService } from "../../src/server/conversation/service";
import { createBookingService } from "../../src/server/booking/service";
import { createConversationRepository } from "../../src/server/db/conversations";
import { createLeadService } from "../../src/server/leads/crm";
import { createHandoffService } from "../../src/server/leads/handoff";
import { startTestDatabase, type TestDatabase } from "./setup";

let db: TestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); }, 30_000);

it("refreshes real slot policy only after saved CRM consent, and never treats an availability failure as free", async () => {
  const repo = createConversationRepository(db.pool);
  const created = await repo.createConversation();
  const owner = { conversationId: created.id, token: created.token };
  const now = () => new Date("2026-11-11T02:00:00Z");
  const getActiveRelease = async () => ({ releaseId: "synthetic-release", policy: DEFAULT_POLICY });
  await repo.saveConversation({ ...owner, state: {}, factsVersion: 1, policyVersion: DEFAULT_POLICY.version, facts: {
    service: "meta_ads", business: "Synthetic store", hasWebsite: true,
    budget: { kind: "total", totalMonthlyVnd: 15_000_000 }, startDate: "2026-12-01",
  } });
  const hubspot = {
    findContactByEmail: async () => ({ id: "contact" }), createContact: async () => ({ id: "contact" }),
    findNoteByMarker: async () => null, createNote: async () => ({ id: "note" }), updateNote: async () => ({ id: "note" }),
  };
  const lead = createLeadService({ pool: db.pool, owner, hubspot, getActiveRelease, now });
  let availabilityReads = 0;
  let fail = false;
  const calendar = {
    freeBusy: async () => { availabilityReads++; if (fail) throw new Error("synthetic read failure"); return []; },
    getEvent: async () => { throw new Error("Refresh must not look up a booking"); },
    insertEvent: async () => { throw new Error("Refresh must not create a booking"); },
  };
  const service = createConversationService({
    pool: db.pool, owner, now, getActiveRelease,
    getLeadService: () => lead,
    getBookingService: async () => createBookingService({ pool: db.pool, owner, calendar, calendarId: "availability@group.calendar.google.com", leadService: lead, getActiveRelease, now }),
    handoffService: createHandoffService({ pool: db.pool, owner, getActiveRelease }),
    extractLeadFacts: async () => { throw new Error("Refresh must not call AI"); },
    answerWithSources: async () => { throw new Error("Refresh must not call AI"); },
    retrieveContext: async () => { throw new Error("Refresh must not retrieve knowledge"); },
  });
  expect((await service.getAvailability()).slots).toEqual([]);
  expect(availabilityReads).toBe(0);
  await lead.submitLead({ contact: { name: "Synthetic prospect", email: "availability@example.com" }, consent: true, factsVersion: 1 }, "crm-consent");
  const available = await service.getAvailability();
  expect((await service.getView()).contact).toEqual({ name: "Synthetic prospect", email: "availability@example.com" });
  expect(available.slots[0]).toMatchObject({ startUtc: "2026-11-12T02:00:00.000Z", endUtc: "2026-11-12T02:30:00.000Z", timeZone: "Asia/Ho_Chi_Minh" });
  expect(available.booking).toBeNull();
  expect(availabilityReads).toBe(1);
  fail = true;
  const failed = await service.getAvailability();
  expect(failed.safeError?.code).toBe("CALENDAR_AVAILABILITY_UNAVAILABLE");
  expect(failed.booking).toBeNull();
  expect(availabilityReads).toBe(2);
  fail = false;
  const recovered = await service.getAvailability();
  expect(recovered.safeError).toBeNull();
  expect(recovered.slots[0].startUtc).toBe("2026-11-12T02:00:00.000Z");
});
