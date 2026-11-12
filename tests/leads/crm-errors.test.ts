import { describe, expect, it } from "vitest";
import { createHubSpotClient, type HubSpotClient } from "../../src/server/integrations/hubspot";

const contact = { name: "Demo Lead", email: "demo@example.test", phone: "+84000000000" };
const marker = "leaddesk:operation:93d92c6b-899a-4a38-8446-63e84543d8c4";
const timestamp = "2026-11-11T02:00:00.000Z";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function object(id: string, properties: Record<string, string>) {
  return { id, properties, createdAt: timestamp, updatedAt: timestamp, archived: false };
}

function client(fetchImpl: typeof fetch) {
  return createHubSpotClient({ token: "test-hubspot-token", fetchImpl, timeoutMs: 100 });
}

function failure(promise: Promise<unknown>, code: string, outcome: "failed" | "unknown", status?: number) {
  return expect(promise).rejects.toMatchObject({ name: "ExternalWriteError", code, outcome, ...(status === undefined ? {} : { status }) });
}

const writes = [
  { name: "create contact", run: (crm: HubSpotClient) => crm.createContact(contact) },
  { name: "create note", run: (crm: HubSpotClient) => crm.createNote({ contactId: "contact-17", body: "Qualified demo lead", marker }) },
  { name: "update note", run: (crm: HubSpotClient) => crm.updateNote("note-23", "Booking confirmed") },
];

describe("HubSpot HTTP write uncertainty", () => {
  it.each(writes)("keeps a lost $name response unknown without issuing a blind retry", async ({ run }) => {
    let requests = 0;
    const crm = client(async () => {
      requests += 1;
      throw new TypeError("Socket closed after the request was sent");
    });

    await failure(run(crm), "network", "unknown");
    expect(requests).toBe(1);
  });

  it.each(writes)("keeps a timed-out $name unknown without issuing a blind retry", async ({ run }) => {
    let requests = 0;
    const crm = client(async () => {
      requests += 1;
      throw new DOMException("The request timed out", "TimeoutError");
    });

    await failure(run(crm), "timeout", "unknown");
    expect(requests).toBe(1);
  });

  it.each(writes)("does not mistake an aborted $name response for a definite remote failure", async ({ run }) => {
    const crm = client(async () => { throw new DOMException("The request was aborted", "AbortError"); });
    await expect(run(crm)).rejects.toMatchObject({ name: "ExternalWriteError", outcome: "unknown" });
  });

  it.each(writes)("keeps a provider 503 on $name unknown instead of retrying the write", async ({ run }) => {
    let requests = 0;
    const crm = client(async () => {
      requests += 1;
      return json({ status: "error", message: "Service unavailable", correlationId: "test-correlation", category: "INTERNAL_ERROR" }, 503);
    });

    await failure(run(crm), "upstream", "unknown", 503);
    expect(requests).toBe(1);
  });

  it.each([
    { status: 401, code: "auth" },
    { status: 403, code: "permission" },
    { status: 429, code: "rate_limited" },
  ])("preserves an explicit $status rejection as failed", async ({ status, code }) => {
    const crm = client(async () => json({ status: "error", message: "Rejected", correlationId: "test-correlation", category: "AUTHENTICATION_ERROR" }, status));
    await failure(crm.createNote({ contactId: "contact-17", body: "Qualified demo lead", marker }), code, "failed", status);
  });

  it("surfaces duplicate email 409 for service reconciliation without creating another contact", async () => {
    let requests = 0;
    const crm = client(async () => {
      requests += 1;
      return json({ status: "error", message: "Contact already exists", correlationId: "test-correlation", category: "CONFLICT" }, 409);
    });

    await failure(crm.createContact(contact), "conflict", "failed", 409);
    expect(requests).toBe(1);
  });

  it.each(writes)("keeps malformed successful $name acknowledgement unknown", async ({ run }) => {
    const crm = client(async () => new Response("not-json", { status: 201 }));
    await failure(run(crm), "invalid_response", "unknown", 201);
  });

  it("does not declare a contact saved when the successful response omits its ID", async () => {
    const crm = client(async () => json({ properties: { email: contact.email } }, 201));
    await failure(crm.createContact(contact), "invalid_response", "unknown", 201);
  });

  it("does not declare a note saved when the successful response omits its ID", async () => {
    const crm = client(async () => json({ properties: { hs_note_body: "Summary" } }, 201));
    await failure(crm.createNote({ contactId: "contact-17", body: "Summary", marker }), "invalid_response", "unknown", 201);
  });
});

describe("HubSpot read-before-reconcile", () => {
  it("finds a contact on a later search page without creating or modifying a contact", async () => {
    const crm = client(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname !== "/crm/v3/objects/contacts/search" || request.method !== "POST") {
        throw new Error(`Unexpected mutation or endpoint: ${request.method} ${url.pathname}`);
      }
      const query = await request.json() as { after?: string };
      if (query.after === undefined) {
        return json({ total: 1, results: [], paging: { next: { after: "page-2", link: "https://api.hubapi.com/crm/v3/objects/contacts/search?after=page-2" } } });
      }
      if (String(query.after) !== "page-2") throw new Error("Search failed to advance its cursor");
      return json({ total: 1, results: [object("contact-17", { email: contact.email, firstname: "Demo", lastname: "Lead" })] });
    });

    await expect(crm.findContactByEmail(contact.email)).resolves.toEqual({ id: "contact-17" });
  });

  it("returns no contact only after a successful empty search, without writing a replacement", async () => {
    const crm = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "POST" || new URL(request.url).pathname !== "/crm/v3/objects/contacts/search") {
        throw new Error("Contact lookup attempted an unexpected write");
      }
      return json({ total: 0, results: [] });
    });
    await expect(crm.findContactByEmail(contact.email)).resolves.toBeNull();
  });

  it("finds an operation marker through paginated contact-note associations without writing a note", async () => {
    const crm = client(async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (request.method !== "GET") throw new Error("Note reconciliation must be read-only");
      if (url.pathname === "/crm/v4/objects/contacts/contact-17/associations/notes") {
        if (url.searchParams.get("after") === null) {
          return json({ results: [{ toObjectId: 22, associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 201, label: null }] }], paging: { next: { after: "page-2", link: "https://api.hubapi.com/crm/v4/objects/contacts/contact-17/associations/notes?after=page-2" } } });
        }
        if (url.searchParams.get("after") !== "page-2") throw new Error("Association lookup failed to advance its cursor");
        return json({ results: [{ toObjectId: 23, associationTypes: [{ category: "HUBSPOT_DEFINED", typeId: 201, label: null }] }] });
      }
      if (url.pathname === "/crm/v3/objects/notes/22") return json(object("22", { hs_note_body: "Another conversation", hs_timestamp: timestamp }));
      if (url.pathname === "/crm/v3/objects/notes/23") return json(object("23", { hs_note_body: `Qualified demo lead\n${marker}`, hs_timestamp: timestamp }));
      throw new Error(`Unexpected reconciliation endpoint: ${url.pathname}`);
    });

    await expect(crm.findNoteByMarker({ contactId: "contact-17", marker })).resolves.toEqual({ id: "23", body: `Qualified demo lead\n${marker}` });
  });

  it("returns no note only after successful association exhaustion", async () => {
    const crm = client(async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET" || new URL(request.url).pathname !== "/crm/v4/objects/contacts/contact-17/associations/notes") {
        throw new Error("Note lookup attempted an unexpected write");
      }
      return json({ results: [] });
    });
    await expect(crm.findNoteByMarker({ contactId: "contact-17", marker })).resolves.toBeNull();
  });

  it("does not convert a failed contact search into no contact", async () => {
    const crm = client(async () => json({ status: "error", message: "Search unavailable", correlationId: "test-correlation", category: "INTERNAL_ERROR" }, 503));
    await failure(crm.findContactByEmail(contact.email), "upstream", "failed", 503);
  });

  it("does not convert a failed note lookup into no matching operation", async () => {
    const crm = client(async () => { throw new TypeError("Network unavailable"); });
    await failure(crm.findNoteByMarker({ contactId: "contact-17", marker }), "network", "failed");
  });

  it("does not convert a malformed search result into permission to create a contact", async () => {
    const crm = client(async () => json({ total: 0 }));
    await failure(crm.findContactByEmail(contact.email), "invalid_response", "failed", 200);
  });

  it("fails missing token configuration before attempting the network", async () => {
    await failure(Promise.resolve().then(() => createHubSpotClient({ token: "", fetchImpl: async () => { throw new Error("Network must not run"); } }).findContactByEmail(contact.email)), "configuration", "failed");
  });
});

describe("HubSpot note reconciliation identity", () => {
  it("persists the operation marker on the correct contact so later reconciliation can find it", async () => {
    const crm = client(async (input, init) => {
      const request = new Request(input, init);
      expect(request.method).toBe("POST");
      expect(new URL(request.url).pathname).toBe("/crm/v3/objects/notes");
      const body = await request.json() as {
        properties: { hs_note_body: string };
        associations: { to: { id: string }; types: { associationCategory: string; associationTypeId: number }[] }[];
      };
      expect(body.properties.hs_note_body).toContain("Qualified demo lead");
      expect(body.properties.hs_note_body).toContain("leaddesk:operation:93d92c6b-899a-4a38-8446-63e84543d8c4");
      expect(body.associations).toContainEqual({
        to: { id: "contact-17" },
        types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }],
      });
      return json(object("note-23", { hs_note_body: `Qualified demo lead\n${marker}`, hs_timestamp: timestamp }), 201);
    });

    await expect(crm.createNote({ contactId: "contact-17", body: "Qualified demo lead", marker })).resolves.toEqual({ id: "note-23" });
  });
});
