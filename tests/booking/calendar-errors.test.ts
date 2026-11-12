import { describe, expect, it } from "vitest";
import { createCalendarClient } from "../../src/server/integrations/google-calendar";
import type { Slot } from "../../src/domain/types";

const calendarId = "leaddesk-test@group.calendar.google.com";
const eventId = "93d92c6b899a4a38844663e84543d8c4";
const slot: Slot = {
  startUtc: "2026-11-12T02:00:00.000Z",
  endUtc: "2026-11-12T02:30:00.000Z",
  timeZone: "Asia/Ho_Chi_Minh",
};
const range = { startUtc: "2026-11-12T00:00:00.000Z", endUtc: "2026-11-13T00:00:00.000Z" };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function event(status = "confirmed") {
  return {
    kind: "calendar#event", etag: '"test-etag"', id: eventId, status,
    htmlLink: `https://calendar.google.com/calendar/event?eid=${eventId}`,
    created: "2026-11-11T02:00:00.000Z", updated: "2026-11-11T02:00:00.000Z",
    summary: "LeadDesk discovery call", creator: { email: "owner@example.test" },
    organizer: { email: calendarId, self: true },
    start: { dateTime: "2026-11-12T02:00:00.000Z", timeZone: "Asia/Ho_Chi_Minh" },
    end: { dateTime: "2026-11-12T02:30:00.000Z", timeZone: "Asia/Ho_Chi_Minh" },
    iCalUID: `${eventId}@google.com`, sequence: 0, reminders: { useDefault: true },
  };
}

function freeBusyResponse(calendars: unknown) {
  return { kind: "calendar#freeBusy", timeMin: range.startUtc, timeMax: range.endUtc, calendars };
}

function client(fetchImpl: typeof fetch) {
  return createCalendarClient({ calendarId, accessToken: "test-calendar-token", fetchImpl, timeoutMs: 100 });
}

function failure(promise: Promise<unknown>, code: string, outcome: "failed" | "unknown", status?: number) {
  return expect(promise).rejects.toMatchObject({ name: "ExternalWriteError", code, outcome, ...(status === undefined ? {} : { status }) });
}

function insert(fetchImpl: typeof fetch) {
  return client(fetchImpl).insertEvent({ eventId, slot, summary: "LeadDesk discovery call" });
}

describe("Calendar availability is unknown until FreeBusy succeeds", () => {
  it("returns the configured calendar's busy intervals, not another calendar's empty result", async () => {
    const calendar = client(async () => json(freeBusyResponse({
      "other@group.calendar.google.com": { busy: [] },
      [calendarId]: { busy: [{ start: "2026-11-12T02:00:00.000Z", end: "2026-11-12T02:30:00.000Z" }] },
    })));

    await expect(calendar.freeBusy(range)).resolves.toEqual([{ startUtc: "2026-11-12T02:00:00.000Z", endUtc: "2026-11-12T02:30:00.000Z" }]);
  });

  it("returns an empty busy list only for an explicitly successful empty calendar", async () => {
    const calendar = client(async () => json(freeBusyResponse({ [calendarId]: { busy: [] } })));
    await expect(calendar.freeBusy(range)).resolves.toEqual([]);
  });

  it.each([
    { name: "missing calendars map", body: { kind: "calendar#freeBusy", timeMin: range.startUtc, timeMax: range.endUtc } },
    { name: "missing requested calendar", body: freeBusyResponse({ "other@group.calendar.google.com": { busy: [] } }) },
    { name: "missing busy list", body: freeBusyResponse({ [calendarId]: {} }) },
    { name: "non-array busy list", body: freeBusyResponse({ [calendarId]: { busy: null } }) },
    { name: "invalid busy timestamp", body: freeBusyResponse({ [calendarId]: { busy: [{ start: "not-a-date", end: slot.endUtc }] } }) },
    { name: "missing busy end", body: freeBusyResponse({ [calendarId]: { busy: [{ start: slot.startUtc }] } }) },
    { name: "reversed busy interval", body: freeBusyResponse({ [calendarId]: { busy: [{ start: slot.endUtc, end: slot.startUtc }] } }) },
    { name: "zero-length busy interval", body: freeBusyResponse({ [calendarId]: { busy: [{ start: slot.startUtc, end: slot.startUtc }] } }) },
  ])("rejects $name rather than manufacturing availability", async ({ body }) => {
    const calendar = client(async () => json(body));
    await failure(calendar.freeBusy(range), "invalid_response", "failed", 200);
  });

  it("does not ignore per-calendar errors even when the same entry contains an empty busy list", async () => {
    const calendar = client(async () => json(freeBusyResponse({ [calendarId]: { errors: [{ domain: "global", reason: "notFound" }], busy: [] } })));
    await expect(calendar.freeBusy(range)).rejects.toMatchObject({ name: "ExternalWriteError", outcome: "failed" });
  });

  it("does not turn FreeBusy HTTP 503 into free time", async () => {
    const calendar = client(async () => json({ error: { code: 503, message: "Unavailable", errors: [{ domain: "global", reason: "backendError", message: "Unavailable" }] } }, 503));
    await failure(calendar.freeBusy(range), "upstream", "failed", 503);
  });

  it.each([
    { name: "network loss", error: new TypeError("Socket closed"), code: "network" },
    { name: "timeout", error: new DOMException("Deadline exceeded", "TimeoutError"), code: "timeout" },
  ])("rejects $name during FreeBusy rather than returning an empty list", async ({ error, code }) => {
    const calendar = client(async () => { throw error; });
    await failure(calendar.freeBusy(range), code, "failed");
  });

  it("does not turn invalid FreeBusy JSON into an empty list", async () => {
    const calendar = client(async () => new Response("not-json", { status: 200 }));
    await failure(calendar.freeBusy(range), "invalid_response", "failed", 200);
  });

  it.each([
    { startUtc: "not-a-date", endUtc: range.endUtc },
    { startUtc: range.startUtc, endUtc: "not-a-date" },
    { startUtc: range.endUtc, endUtc: range.startUtc },
    { startUtc: range.startUtc, endUtc: range.startUtc },
  ])("rejects invalid query times before reading availability: $startUtc to $endUtc", async (invalidRange) => {
    const calendar = client(async () => { throw new Error("Invalid input must not reach the network"); });
    await failure(Promise.resolve().then(() => calendar.freeBusy(invalidRange)), "invalid_input", "failed");
  });
});

describe("Calendar event write uncertainty", () => {
  it.each([
    { name: "network loss after dispatch", error: new TypeError("Socket closed after provider accepted the request"), code: "network" },
    { name: "timeout after dispatch", error: new DOMException("Deadline exceeded", "TimeoutError"), code: "timeout" },
  ])("keeps $name unknown and never retries the event insert", async ({ error, code }) => {
    let requests = 0;
    const result = insert(async () => {
      requests += 1;
      throw error;
    });

    await failure(result, code, "unknown");
    expect(requests).toBe(1);
  });

  it("does not claim definite failure when the event response is aborted", async () => {
    await expect(insert(async () => { throw new DOMException("Aborted", "AbortError"); })).rejects.toMatchObject({ name: "ExternalWriteError", outcome: "unknown" });
  });

  it("keeps insert HTTP 503 unknown without creating a second event", async () => {
    let requests = 0;
    const result = insert(async () => {
      requests += 1;
      return json({ error: { code: 503, message: "Unavailable", errors: [{ domain: "global", reason: "backendError", message: "Unavailable" }] } }, 503);
    });

    await failure(result, "upstream", "unknown", 503);
    expect(requests).toBe(1);
  });

  it.each([
    { status: 401, code: "auth" },
    { status: 403, code: "permission" },
    { status: 429, code: "rate_limited" },
  ])("preserves explicit insert HTTP $status rejection as failed", async ({ status, code }) => {
    await failure(insert(async () => json({ error: { code: status, message: "Rejected", errors: [{ domain: "global", reason: "forbidden", message: "Rejected" }] } }, status)), code, "failed", status);
  });

  it("surfaces an existing event 409 for service reconciliation without inventing another event ID", async () => {
    let requests = 0;
    const result = insert(async () => {
      requests += 1;
      return json({ error: { code: 409, message: "The requested identifier already exists", errors: [{ domain: "global", reason: "duplicate", message: "The requested identifier already exists" }] } }, 409);
    });

    await failure(result, "conflict", "failed", 409);
    expect(requests).toBe(1);
  });

  it("keeps malformed successful insert acknowledgement unknown", async () => {
    await failure(insert(async () => new Response("not-json", { status: 200 })), "invalid_response", "unknown", 200);
  });

  it("does not announce booking success when the event acknowledgement has no ID", async () => {
    await failure(insert(async () => json({ kind: "calendar#event", status: "confirmed" })), "invalid_response", "unknown", 200);
  });

  it("inserts only on the explicit test calendar without attendees, Meet, or invitations", async () => {
    const result = insert(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      expect(request.method).toBe("POST");
      expect(decodeURIComponent(url.pathname)).toBe(`/calendar/v3/calendars/${calendarId}/events`);
      expect(url.searchParams.get("sendUpdates")).toBe("none");
      expect(url.searchParams.has("conferenceDataVersion")).toBe(false);
      const body = await request.json() as Record<string, unknown>;
      expect(body).not.toHaveProperty("attendees");
      expect(body).not.toHaveProperty("conferenceData");
      expect(body).not.toHaveProperty("hangoutLink");
      expect(body.id).toBe("93d92c6b899a4a38844663e84543d8c4");
      return json(event());
    });

    await expect(result).resolves.toMatchObject({ status: "confirmed" });
  });

  it.each([
    { startUtc: "bad", endUtc: slot.endUtc, timeZone: "Asia/Ho_Chi_Minh" as const },
    { startUtc: slot.startUtc, endUtc: "bad", timeZone: "Asia/Ho_Chi_Minh" as const },
    { startUtc: slot.endUtc, endUtc: slot.startUtc, timeZone: "Asia/Ho_Chi_Minh" as const },
    { startUtc: slot.startUtc, endUtc: slot.startUtc, timeZone: "Asia/Ho_Chi_Minh" as const },
  ])("rejects invalid event times before insert: $startUtc to $endUtc", async (invalidSlot) => {
    const calendar = client(async () => { throw new Error("Invalid event must not reach the network"); });
    await failure(Promise.resolve().then(() => calendar.insertEvent({ eventId, slot: invalidSlot, summary: "Demo" })), "invalid_input", "failed");
  });
});

describe("Calendar reads reconcile only the original event", () => {
  it("reads an existing event by its stable ID and exposes its actual UTC interval", async () => {
    const calendar = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET" || decodeURIComponent(new URL(request.url).pathname) !== `/calendar/v3/calendars/${calendarId}/events/${eventId}`) {
        throw new Error("Reconciliation attempted a write or selected a different event");
      }
      return json(event());
    });

    await expect(calendar.getEvent(eventId)).resolves.toEqual({ id: "93d92c6b899a4a38844663e84543d8c4", status: "confirmed", startUtc: "2026-11-12T02:00:00.000Z", endUtc: "2026-11-12T02:30:00.000Z" });
  });

  it("returns no event for explicit 404 without trying to create it", async () => {
    const calendar = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET") throw new Error("A missing event is not permission for the adapter to insert one");
      return json({ error: { code: 404, message: "Not found", errors: [{ domain: "global", reason: "notFound", message: "Not found" }] } }, 404);
    });
    await expect(calendar.getEvent(eventId)).resolves.toBeNull();
  });

  it("does not convert a failed reconciliation read into absence", async () => {
    const calendar = client(async () => { throw new TypeError("Network unavailable"); });
    await failure(calendar.getEvent(eventId), "network", "failed");
  });

  it("preserves cancelled status rather than reporting an existing cancelled event as booked", async () => {
    const calendar = client(async () => json(event("cancelled")));
    await expect(calendar.getEvent(eventId)).resolves.toMatchObject({ id: eventId, status: "cancelled" });
  });
});

describe("Calendar configuration cannot select a personal default", () => {
  it.each(["", " ", "primary"])("rejects unsafe calendar ID %j before the network", async (invalidId) => {
    await failure(Promise.resolve().then(() => createCalendarClient({ calendarId: invalidId, accessToken: "test-token", fetchImpl: async () => { throw new Error("Unsafe calendar must not reach the network"); } }).freeBusy(range)), "configuration", "failed");
  });

  it("rejects missing access token before the network", async () => {
    await failure(Promise.resolve().then(() => createCalendarClient({ calendarId, accessToken: "", fetchImpl: async () => { throw new Error("Missing token must not reach the network"); } }).freeBusy(range)), "configuration", "failed");
  });
});
