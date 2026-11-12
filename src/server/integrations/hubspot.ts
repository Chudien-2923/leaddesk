import "server-only";
import type { Contact } from "../../domain/types";

export interface HubSpotClient {
  findContactByEmail(email: string): Promise<{ id: string } | null>;
  createContact(contact: Contact): Promise<{ id: string }>;
  createNote(input: { contactId: string; body: string; marker: string }): Promise<{ id: string }>;
  findNoteByMarker(input: { contactId: string; marker: string }): Promise<{ id: string; body: string } | null>;
  updateNote(noteId: string, body: string): Promise<{ id: string }>;
}
export class ExternalWriteError extends Error {
  readonly name = "ExternalWriteError";
  constructor(public readonly code: string, public readonly outcome: "failed" | "unknown", public readonly status?: number) {
    super(`HubSpot request ${code}`);
  }
}
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value: unknown): value is Record<string, unknown> & { id: string } => record(value) && typeof value.id === "string" && value.id.length > 0;

export function createHubSpotClient(options: { token: string; fetchImpl?: typeof fetch; timeoutMs?: number }): HubSpotClient {
  if (!options.token?.trim() || /[\r\n]/.test(options.token)) throw new ExternalWriteError("configuration", "failed");
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ExternalWriteError("configuration", "failed");
  async function request(path: string, method: string, body: unknown, write: boolean): Promise<{ data: unknown; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const uncertain = write ? "unknown" : "failed";
    try {
      const response = await fetchImpl(`https://api.hubapi.com${path}`, {
        method, headers: { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "error",
      });
      if (!response.ok) {
        const code = response.status === 401 ? "auth" : response.status === 403 ? "permission" : response.status === 409 ? "conflict" : response.status === 429 ? "rate_limited" : response.status >= 500 ? "upstream" : "rejected";
        throw new ExternalWriteError(code, response.status >= 500 ? uncertain : "failed", response.status);
      }
      try { return { data: await response.json(), status: response.status }; }
      catch { throw new ExternalWriteError("invalid_response", uncertain, response.status); }
    } catch (error) {
      if (error instanceof ExternalWriteError) throw error;
      const timedOut = controller.signal.aborted || (error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name));
      throw new ExternalWriteError(timedOut ? "timeout" : "network", uncertain);
    } finally { clearTimeout(timer); }
  }
  async function write(path: string, method: string, body: unknown) {
    const response = await request(path, method, body, true);
    if (!identity(response.data)) throw new ExternalWriteError("invalid_response", "unknown", response.status);
    return { id: response.data.id };
  }
  function page(data: unknown, status: number): { results: unknown[]; after?: string } {
    if (!record(data) || !Array.isArray(data.results)) throw new ExternalWriteError("invalid_response", "failed", status);
    let after: string | undefined;
    if (data.paging !== undefined) {
      if (!record(data.paging)) throw new ExternalWriteError("invalid_response", "failed", status);
      if (data.paging.next !== undefined) {
        if (!record(data.paging.next) || !["string", "number"].includes(typeof data.paging.next.after) || String(data.paging.next.after).length === 0) throw new ExternalWriteError("invalid_response", "failed", status);
        after = String(data.paging.next.after);
      }
    }
    return { results: data.results, after };
  }
  return {
    async findContactByEmail(email) {
      let after: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await request("/crm/v3/objects/contacts/search", "POST", {
          filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email.trim().toLowerCase() }] }],
          properties: ["email"], limit: 100, ...(after === undefined ? {} : { after }),
        }, false);
        const current = page(response.data, response.status);
        for (const item of current.results) {
          if (!identity(item) || !record(item.properties) || typeof item.properties.email !== "string") throw new ExternalWriteError("invalid_response", "failed", response.status);
          if (item.properties.email.toLowerCase() === email.trim().toLowerCase()) return { id: item.id };
        }
        after = current.after;
        if (after !== undefined && seen.has(after)) throw new ExternalWriteError("invalid_response", "failed", response.status);
        if (after !== undefined) seen.add(after);
      } while (after !== undefined);
      return null;
    },
    createContact(contact) {
      return write("/crm/v3/objects/contacts", "POST", { properties: { email: contact.email, firstname: contact.name, ...(contact.phone ? { phone: contact.phone } : {}) } });
    },
    createNote(input) {
      return write("/crm/v3/objects/notes", "POST", {
        properties: { hs_timestamp: new Date().toISOString(), hs_note_body: `${escapeHtml(input.body)}\n${escapeHtml(input.marker)}` },
        associations: [{ to: { id: input.contactId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] }],
      });
    },
    async findNoteByMarker(input) {
      let after: string | undefined;
      const seen = new Set<string>();
      do {
        const response = await request(`/crm/v4/objects/contacts/${encodeURIComponent(input.contactId)}/associations/notes?limit=100${after === undefined ? "" : `&after=${encodeURIComponent(after)}`}`, "GET", undefined, false);
        const current = page(response.data, response.status);
        for (const item of current.results) {
          if (!record(item) || !["string", "number"].includes(typeof item.toObjectId) || !String(item.toObjectId)) throw new ExternalWriteError("invalid_response", "failed", response.status);
          const note = await request(`/crm/v3/objects/notes/${encodeURIComponent(String(item.toObjectId))}?properties=hs_note_body`, "GET", undefined, false);
          if (!identity(note.data) || !record(note.data.properties) || typeof note.data.properties.hs_note_body !== "string") throw new ExternalWriteError("invalid_response", "failed", note.status);
          const body = note.data.properties.hs_note_body;
          if (body.split(/\r?\n|<[^>]*>/).some(line => line.trim() === input.marker)) return { id: note.data.id, body };
        }
        after = current.after;
        if (after !== undefined && seen.has(after)) throw new ExternalWriteError("invalid_response", "failed", response.status);
        if (after !== undefined) seen.add(after);
      } while (after !== undefined);
      return null;
    },
    updateNote(noteId, body) {
      return write(`/crm/v3/objects/notes/${encodeURIComponent(noteId)}`, "PATCH", { properties: { hs_note_body: escapeHtml(body) } });
    },
  };
}
