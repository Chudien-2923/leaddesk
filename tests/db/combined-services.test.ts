import { afterAll, beforeAll, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import type { ServiceId } from "../../src/domain/types";
import { createPromptFunctions } from "../../src/server/ai/prompts";
import { PRIMARY_MODEL } from "../../src/server/ai/types";
import { createBookingService } from "../../src/server/booking/service";
import { createConversationService } from "../../src/server/conversation/service";
import { createConversationRepository } from "../../src/server/db/conversations";
import type { CalendarClient, CalendarEvent } from "../../src/server/integrations/google-calendar";
import type { HubSpotClient } from "../../src/server/integrations/hubspot";
import { createLeadService } from "../../src/server/leads/crm";
import { createHandoffService } from "../../src/server/leads/handoff";
import { startTestDatabase, type TestDatabase } from "./setup";

let db: TestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); }, 30_000);
const contact = { name: "Synthetic combined prospect", email: "combined@example.com" };

async function fixture() {
  const repository = createConversationRepository(db.pool);
  const created = await repository.createConversation();
  const owner = { conversationId: created.id, token: created.token };
  const now = () => new Date("2026-11-11T02:00:00Z");
  const getActiveRelease = async () => ({ releaseId: "44444444-4444-4444-8444-444444444444", policy: DEFAULT_POLICY });
  await repository.saveConversation({ ...owner, state: {}, factsVersion: 1, policyVersion: DEFAULT_POLICY.version, facts: {
    service: null, business: "Synthetic store", hasWebsite: true, budget: { kind: "total", totalMonthlyVnd: 36_000_000 }, startDate: "2026-12-12",
  } });
  let serviceChoice: ServiceId = "both_ads";
  const notes: string[] = [];
  const events = new Map<string, CalendarEvent>();
  const hubspot: HubSpotClient = {
    findContactByEmail: async () => ({ id: "existing-contact" }),
    createContact: async () => { throw new Error("The existing contact must be reused"); },
    findNoteByMarker: async () => null,
    createNote: async input => { notes.push(input.body); return { id: "combined-note" }; },
    updateNote: async (_id, body) => { notes.push(body); return { id: "combined-note" }; },
  };
  const calendar: CalendarClient = {
    freeBusy: async () => [],
    getEvent: async id => events.get(id) ?? null,
    insertEvent: async ({ eventId, slot }) => {
      const event = { id: eventId, startUtc: slot.startUtc, endUtc: slot.endUtc, status: "confirmed" };
      events.set(eventId, event);
      return event;
    },
  };
  const lead = createLeadService({ pool: db.pool, owner, hubspot, getActiveRelease, now });
  const prompts = createPromptFunctions(async input => ({
    text: JSON.stringify(input.purpose === "extract" ? { service: serviceChoice } : { kind: "conversation", text: "Please review your next steps.", sourceIds: [] }),
    requestedModel: PRIMARY_MODEL, reportedModel: PRIMARY_MODEL, fallbackUsed: false,
  }));
  const service = createConversationService({
    pool: db.pool, owner, now, getActiveRelease, ...prompts,
    retrieveContext: async () => ({ citations: [], text: "", estimatedTokens: 0 }),
    getLeadService: () => lead,
    getBookingService: async () => createBookingService({ pool: db.pool, owner, calendar, calendarId: `${created.id}@group.calendar.google.com`, leadService: lead, getActiveRelease, now }),
    handoffService: createHandoffService({ pool: db.pool, owner, getActiveRelease }),
  });
  return { service, notes, events, choose: (choice: ServiceId) => { serviceChoice = choice; } };
}

it("qualifies both after an existing review request, then requires CRM consent before one confirmed booking", async () => {
  const f = await fixture();
  const reviewed = await f.service.handleEvent({ type: "request_handoff", contact, consent: true, reason: "Synthetic review", key: "review" }, new AbortController().signal);
  expect(reviewed.handoff?.status).toBe("saved");
  expect(reviewed.qualification).toMatchObject({ status: "needs_info", missing: ["service"] });
  expect(reviewed.allowedActions).not.toContain("select_slot");
  expect(f.notes).toEqual([]);
  const qualified = await f.service.handleEvent({ type: "message", text: "I choose both Meta Ads and Google Ads." }, new AbortController().signal);
  expect(qualified.safeError).toBeNull();
  expect(qualified.facts.service).toBe("both_ads");
  expect(qualified.qualification.status).toBe("qualified");
  expect(qualified.factsVersion).toBe(2);
  expect(qualified.crm.status).toBe("none");
  expect(qualified.allowedActions).toContain("submit_contact");
  expect(qualified.allowedActions).not.toContain("select_slot");
  expect((await f.service.getAvailability()).slots).toEqual([]);
  expect(f.events.size).toBe(0);

  const saved = await f.service.handleEvent({ type: "submit_contact", contact, consent: true, factsVersion: qualified.factsVersion, key: "crm" }, new AbortController().signal);
  expect(saved.crm.status).toBe("saved");
  expect(f.notes[0]).toContain("Meta Ads");
  expect(f.notes[0]).toContain("Google Ads");
  expect(f.notes[0]).toContain("36000000");
  expect(saved.allowedActions).toContain("select_slot");
  const slot = saved.slots[0];
  expect(slot).toBeDefined();
  const selected = await f.service.handleEvent({ type: "select_slot", startUtc: slot.startUtc }, new AbortController().signal);
  expect(selected.booking).toBeNull();
  expect(f.events.size).toBe(0);
  const booked = await f.service.handleEvent({ type: "confirm_slot", startUtc: slot.startUtc, factsVersion: saved.factsVersion, confirmed: true, key: "booking" }, new AbortController().signal);
  expect(booked.safeError).toBeNull();
  expect(booked.booking).toMatchObject({ status: "booked", crmSyncStatus: "succeeded", slot });
  expect(f.events.size).toBe(1);
  const confirmed = booked.booking;
  f.choose("meta_ads");
  const corrected = await f.service.handleEvent({ type: "message", text: "Actually, only Meta Ads." }, new AbortController().signal);
  expect(corrected.facts.service).toBe("meta_ads");
  expect(corrected.factsVersion).toBe(3);
  expect(corrected.booking).toEqual(confirmed);
  expect(f.events.size).toBe(1);
});

it("invalidates combined CRM consent and selected time when the visitor changes to one service", async () => {
  const f = await fixture();
  const qualified = await f.service.handleEvent({ type: "message", text: "Both platforms, please." }, new AbortController().signal);
  const saved = await f.service.handleEvent({ type: "submit_contact", contact, consent: true, factsVersion: qualified.factsVersion, key: "crm" }, new AbortController().signal);
  const selected = await f.service.handleEvent({ type: "select_slot", startUtc: saved.slots[0].startUtc }, new AbortController().signal);
  f.choose("google_ads");
  const corrected = await f.service.handleEvent({ type: "message", text: "Only Google Ads now." }, new AbortController().signal);
  expect(corrected.facts.service).toBe("google_ads");
  expect(corrected.factsVersion).toBe(selected.factsVersion + 1);
  expect(corrected.crm.status).toBe("none");
  expect(corrected.selectedSlot).toBeNull();
  expect(corrected.slots).toEqual([]);
  expect(corrected.allowedActions).not.toContain("confirm_slot");
  const stale = await f.service.handleEvent({ type: "confirm_slot", startUtc: saved.slots[0].startUtc, factsVersion: selected.factsVersion, confirmed: true, key: "stale-booking" }, new AbortController().signal);
  expect(stale.safeError?.code).toBe("STALE_FACTS");
  expect(stale.booking).toBeNull();
  expect(f.events.size).toBe(0);
});
