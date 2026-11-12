import "server-only";
import { lstat, readFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { OAuth2Client } from "google-auth-library";
import { z } from "zod";
import type { BusyInterval, Slot } from "../../domain/types";

export interface CalendarEvent { id: string; startUtc: string; endUtc: string; status: string }
export interface CalendarClient {
  freeBusy(range: { startUtc: string; endUtc: string }): Promise<BusyInterval[]>;
  insertEvent(input: { eventId: string; slot: Slot; summary: string }): Promise<CalendarEvent>;
  getEvent(eventId: string): Promise<CalendarEvent | null>;
}
export class ExternalWriteError extends Error {
  readonly name = "ExternalWriteError";
  constructor(readonly code: string, readonly outcome: "failed" | "unknown", readonly status?: number) {
    super(`Calendar request ${outcome}: ${code}`);
  }
}
const timestamp = z.iso.datetime({ offset: true });
const interval = z.object({ startUtc: timestamp, endUtc: timestamp }).refine(v => Date.parse(v.endUtc) > Date.parse(v.startUtc));
const eventIdSchema = z.string().regex(/^[0-9a-v]{5,1024}$/);
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const invalid = (write: boolean, status?: number) => new ExternalWriteError("invalid_response", write ? "unknown" : "failed", status);

export function createCalendarClient(options: { calendarId: string; accessToken: string; fetchImpl?: typeof fetch; timeoutMs?: number }): CalendarClient {
  const { calendarId, accessToken, fetchImpl = fetch, timeoutMs = 15_000 } = options;
  if (!calendarId?.trim() || calendarId.trim().toLowerCase() === "primary" || calendarId !== calendarId.trim() || !accessToken?.trim() || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ExternalWriteError("configuration", "failed");
  }
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  async function request(url: string, init: RequestInit, write: boolean, allow404 = false): Promise<unknown> {
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      throw new ExternalWriteError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", write ? "unknown" : "failed");
    }
    if (response.status === 404 && allow404) return null;
    if (!response.ok) {
      const code = response.status === 401 ? "auth" : response.status === 403 ? "permission" : response.status === 429 ? "rate_limited" : response.status === 409 ? "conflict" : "upstream";
      throw new ExternalWriteError(code, write && (response.status >= 500 || response.status === 408) ? "unknown" : "failed", response.status);
    }
    try { return await response.json(); } catch { throw invalid(write, response.status); }
  }
  function parseEvent(value: unknown, expectedId: string, write: boolean): CalendarEvent {
    if (!object(value) || value.id !== expectedId || !["confirmed", "tentative", "cancelled"].includes(String(value.status))) throw invalid(write, 200);
    // Google tombstones may omit times. Preserve cancellation without treating it as a booking.
    if (value.status === "cancelled" && (!object(value.start) || !object(value.end))) return { id: expectedId, status: "cancelled", startUtc: "", endUtc: "" };
    const times = interval.safeParse({ startUtc: object(value.start) ? value.start.dateTime : undefined, endUtc: object(value.end) ? value.end.dateTime : undefined });
    if (!times.success) throw invalid(write, 200);
    return { id: expectedId, status: String(value.status), startUtc: new Date(times.data.startUtc).toISOString(), endUtc: new Date(times.data.endUtc).toISOString() };
  }
  return {
    async freeBusy(range) {
      if (!interval.safeParse(range).success) throw new ExternalWriteError("invalid_input", "failed");
      const body = await request("https://www.googleapis.com/calendar/v3/freeBusy", { method: "POST", body: JSON.stringify({ timeMin: range.startUtc, timeMax: range.endUtc, items: [{ id: calendarId }] }) }, false);
      if (!object(body) || !object(body.calendars) || !object(body.calendars[calendarId])) throw invalid(false, 200);
      const entry = body.calendars[calendarId];
      if ((entry.errors !== undefined && (!Array.isArray(entry.errors) || entry.errors.length !== 0)) || !Array.isArray(entry.busy)) throw invalid(false, 200);
      return entry.busy.map(value => {
        const parsed = interval.safeParse(object(value) ? { startUtc: value.start, endUtc: value.end } : null);
        if (!parsed.success) throw invalid(false, 200);
        return { startUtc: new Date(parsed.data.startUtc).toISOString(), endUtc: new Date(parsed.data.endUtc).toISOString() };
      });
    },
    async insertEvent(input) {
      if (!eventIdSchema.safeParse(input.eventId).success || !interval.safeParse(input.slot).success || input.slot.timeZone !== "Asia/Ho_Chi_Minh" || !input.summary?.trim() || input.summary.length > 1000) throw new ExternalWriteError("invalid_input", "failed");
      const body = await request(`${base}?sendUpdates=none`, { method: "POST", body: JSON.stringify({ id: input.eventId, summary: input.summary, start: { dateTime: input.slot.startUtc, timeZone: input.slot.timeZone }, end: { dateTime: input.slot.endUtc, timeZone: input.slot.timeZone } }) }, true);
      const result = parseEvent(body, input.eventId, true);
      if (result.status !== "cancelled" && (Date.parse(result.startUtc) !== Date.parse(input.slot.startUtc) || Date.parse(result.endUtc) !== Date.parse(input.slot.endUtc))) throw invalid(true, 200);
      return result;
    },
    async getEvent(eventId) {
      if (!eventIdSchema.safeParse(eventId).success) throw new ExternalWriteError("invalid_input", "failed");
      const body = await request(`${base}/${encodeURIComponent(eventId)}`, { method: "GET" }, false, true);
      return body === null ? null : parseEvent(body, eventId, false);
    },
  };
}

// A dedicated calendar owned by this OAuth user permits the narrower events.owned scope.
export const CALENDAR_OAUTH_SCOPES = ["https://www.googleapis.com/auth/calendar.freebusy", "https://www.googleapis.com/auth/calendar.events.owned"] as const;
export const CALENDAR_TOKEN_FILE = resolve(process.cwd(), ".local/google/tokens.json");
export const CALENDAR_CREDENTIALS_FILE = resolve(process.cwd(), ".local/google/credentials.json");

export async function createConfiguredCalendarClient(): Promise<CalendarClient> {
  try {
    const calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!calendarId?.trim() || calendarId.trim().toLowerCase() === "primary" || calendarId !== calendarId.trim()) throw new Error("configuration");
    const directory = await lstat(resolve(process.cwd(), ".local/google"));
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0 || (typeof process.getuid === "function" && directory.uid !== process.getuid())) throw new Error("configuration");
    let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      const stat = await lstat(CALENDAR_CREDENTIALS_FILE);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("configuration");
      const file = JSON.parse(await readFile(CALENDAR_CREDENTIALS_FILE, "utf8"));
      const credentials = file.installed ?? file.web;
      clientId = credentials?.client_id;
      clientSecret = credentials?.client_secret;
    }
    if (typeof clientId !== "string" || !clientId.trim() || typeof clientSecret !== "string" || !clientSecret.trim()) throw new Error("configuration");
    const stat = await lstat(CALENDAR_TOKEN_FILE);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid())) throw new Error("configuration");
    const tokens = JSON.parse(await readFile(CALENDAR_TOKEN_FILE, "utf8"));
    const oauth = new OAuth2Client(clientId, clientSecret);
    oauth.setCredentials(tokens);
    const access = await oauth.getAccessToken();
    if (!access.token) throw new Error("configuration");
    // Persist rotated/renewed credentials without logging bearer material.
    await mkdir(resolve(process.cwd(), ".local/google"), { recursive: true, mode: 0o700 });
    await writeFile(CALENDAR_TOKEN_FILE, JSON.stringify({ ...tokens, ...oauth.credentials }), { mode: 0o600 });
    await chmod(CALENDAR_TOKEN_FILE, 0o600);
    return createCalendarClient({ calendarId, accessToken: access.token });
  } catch { throw new ExternalWriteError("configuration", "failed"); }
}
