// Operator-only acceptance runner. Importing this file never dispatches a request.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { contactSchema } from "../src/domain/contact";
import { agencyPolicySchema, agencyToday } from "../src/domain/policy";
import { leadFactsSchema, localDateSchema, qualify } from "../src/domain/qualification";
import { conversationEventSchema, type ConversationEvent } from "../src/server/conversation/state";
import type { PublicChatView } from "../src/server/conversation/public-view";

export interface Options {
  baseUrl: string;
  statePath: string;
  allowTestWrites: boolean;
  preflightOnly: boolean;
  serverUsesThisEnv: boolean;
  testProjectRef?: string;
  testHubspotPortal?: string;
  testCalendarId?: string;
}
class Stop extends Error {
  constructor(readonly code: string) { super(code); }
}
function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Stop(code);
}
function loopbackOrigin(input: string): string {
  // Check the spelling BEFORE URL canonicalization (127.1/integer IPv4 normalize to loopback).
  need(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?\/?$/.test(input), "unsafe_base_url");
  const url = new URL(input);
  need(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "unsafe_base_url");
  return url.origin;
}
export function parseOptions(argv: string[]): Options {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  const valued: Record<string, true> = { "--base-url": true, "--state": true, "--test-project-ref": true, "--test-hubspot-portal": true, "--test-calendar-id": true };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    need(!values.has(key) && !flags.has(key), "duplicate_argument");
    if (key === "--allow-test-writes" || key === "--preflight-only" || key === "--server-uses-this-env") flags.add(key);
    else {
      need(Object.hasOwn(valued, key) && argv[index + 1] && !argv[index + 1].startsWith("--"), "invalid_argument");
      values.set(key, argv[++index]);
    }
  }
  const statePath = resolve(values.get("--state") ?? `.local/smoke/${randomUUID()}.json`);
  const within = relative(resolve(".local/smoke"), statePath);
  need(within !== "" && !within.startsWith(`..${sep}`) && within !== ".." && !within.startsWith(sep) && statePath.endsWith(".json"), "unsafe_state_path");
  return {
    baseUrl: loopbackOrigin(values.get("--base-url") ?? "http://127.0.0.1:3102"), statePath,
    allowTestWrites: flags.has("--allow-test-writes"), preflightOnly: flags.has("--preflight-only"),
    serverUsesThisEnv: flags.has("--server-uses-this-env"),
    testProjectRef: values.get("--test-project-ref"), testHubspotPortal: values.get("--test-hubspot-portal"),
    testCalendarId: values.get("--test-calendar-id"),
  };
}
export function assertStateTarget(options: Options, state: { baseUrl: string }): void {
  need(loopbackOrigin(state.baseUrl) === options.baseUrl, "state_origin_mismatch");
}
export async function requestLocal(options: Options, cookie: string, path: string, payload?: unknown): Promise<Response> {
  need(/^\/api\/conversations(?:\/[a-f0-9-]{36}(?:\/events|\/availability)?)?$/.test(path), "unsafe_local_path");
  need(loopbackOrigin(options.baseUrl) === options.baseUrl, "unsafe_base_url");
  if (payload !== undefined) {
    need(options.allowTestWrites && !options.preflightOnly, "allow-test-writes_required");
    need(options.serverUsesThisEnv, "server-uses-this-env_required");
  }
  need(!/[\r\n]/.test(cookie), "invalid_cookie");
  const response = await fetch(`${options.baseUrl}${path}`, {
    method: payload === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(180_000),
    headers: { Origin: options.baseUrl, ...(cookie ? { Cookie: cookie } : {}), ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  need(response.status < 300 || response.status >= 400, "local_redirect_rejected");
  return response;
}
const slotSchema = z.object({ startUtc: z.iso.datetime({ offset: true }), endUtc: z.iso.datetime({ offset: true }), timeZone: z.literal("Asia/Ho_Chi_Minh") });
const citationSchema = z.object({ chunkId: z.uuid(), documentId: z.uuid(), releaseId: z.uuid(), title: z.string().min(1), excerpt: z.string().min(1) });
const auditMessageSchema = z.object({
  id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), citations: z.array(citationSchema).optional(),
  model: z.object({ requestedModel: z.enum(["google-antigravity/gemini-3.8-flash", "openai-codex/gpt-5.6-luna"]), reportedModel: z.string().min(1), fallbackUsed: z.boolean() }).optional(),
});
const viewSchema = z.object({
  conversationId: z.uuid(), messages: z.array(z.object({ id: z.string(), role: z.enum(["user", "assistant"]), text: z.string() }).strict()),
  facts: leadFactsSchema, factsVersion: z.number().int().nonnegative(), factsValidationPending: z.boolean(), policyVersion: z.string().nullable(),
  qualification: z.object({ status: z.enum(["needs_info", "qualified", "not_qualified", "manual_review"]), missing: z.array(z.string()), reasons: z.array(z.string()) }),
  missingFields: z.array(z.string()), contact: contactSchema.nullable(), crm: z.object({ status: z.enum(["none", "saved", "partial", "unknown", "failed"]), operationId: z.string().optional(), safeCode: z.string().optional() }),
  allowedActions: z.array(z.enum(["message", "submit_contact", "request_handoff", "select_slot", "confirm_slot"])), slots: z.array(slotSchema), selectedSlot: slotSchema.nullable(),
  booking: z.object({ status: z.string(), eventId: z.string().optional(), operationId: z.string().optional(), slot: slotSchema.optional(), crmSyncStatus: z.string().optional() }).nullable(),
  handoff: z.object({ status: z.literal("saved"), handoffId: z.string() }).nullable(), safeError: z.object({ code: z.string(), message: z.string() }).nullable(),
}).strict();
const intentSchema = z.object({ payload: z.unknown(), status: z.enum(["dispatching", "acknowledged"]) });
const stateSchema = z.object({
  version: z.literal(1), baseUrl: z.string(), conversationId: z.union([z.uuid(), z.literal("")]), cookie: z.string(),
  keys: z.object({ crm: z.string().min(1).max(256), booking: z.string().min(1).max(256), handoff: z.string().min(1).max(256) }),
  contact: contactSchema, startDate: localDateSchema,
  intents: z.record(z.string(), intentSchema).optional(), completed: z.boolean().optional(),
  targets: z.object({ projectRef: z.string(), hubspotPortal: z.string(), calendarId: z.string() }).optional(),
}).passthrough();
type State = z.infer<typeof stateSchema>;
type Snapshot = {
  leads: { operation_id: string; consent_id: string; contact_id: string | null; note_id: string | null; marker: string; status: string; contact: z.infer<typeof contactSchema>; facts_version: string; policy_version: string; granted: boolean; purpose: string; consent_facts_version: string; consent_policy_version: string }[];
  bookings: { operation_id: string; event_id: string; calendar_id: string; start_utc: Date; end_utc: Date; status: string; crm_sync_status: string; note_id: string; granted: boolean; purpose: string; facts_version: string; policy_version: string; consent_facts_version: string; consent_policy_version: string }[];
  operations: { id: string; kind: string; key: string; status: string; payload_hash: string }[];
  handoffs: { id: string; granted: boolean; purpose: string }[];
};
type ConsentSnapshot = Pick<Snapshot["leads"][number], "facts_version" | "policy_version" | "consent_facts_version" | "consent_policy_version">;
export function assertCompletedVersions(lead: ConsentSnapshot, booking: ConsentSnapshot): void {
  need(lead.consent_facts_version === lead.facts_version && lead.consent_policy_version === lead.policy_version
    && booking.consent_facts_version === booking.facts_version && booking.consent_policy_version === booking.policy_version
    && booking.facts_version === lead.facts_version && booking.policy_version === lead.policy_version, "consent_version_mismatch");
}
interface TargetConfiguration { projectRef: string; hubspotPortal: string; calendarId: string; hubspotToken: string; connectionString: string }
interface Targets { projectRef: string; hubspotPortal: string; calendarId: string; hubspotToken: string; calendarToken: string; pool: PoolClient }
interface Report {
  version: 1; mode: "preflight-only" | "read-only-resume" | "completed-state-verification" | "fresh-full-scenario";
  status: "blocked" | "preflight-only" | "verified"; checks: string[]; code?: string; fullScenarioExecuted: boolean;
}
async function privateDirectory(path: string): Promise<void> {
  const parts = relative(process.cwd(), path).split(sep);
  need(parts[0] === ".local" && !parts.includes(".."), "unsafe_private_directory");
  let current = process.cwd();
  for (const part of parts) {
    current = resolve(current, part);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const info = await lstat(current);
    need(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()), "unsafe_private_directory");
  }
}
async function readPrivate(path: string): Promise<string> {
  await privateDirectory(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    need(info.isFile() && (info.mode & 0o077) === 0 && (process.getuid === undefined || info.uid === process.getuid()), "unsafe_private_file");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function saveState(path: string, state: State, createOnly = false): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = createOnly ? path : `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(state, null, 2)); await handle.sync(); } finally { await handle.close(); }
  if (!createOnly) await rename(temporary, path);
}
async function upstream(url: string, token?: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const parsed = new URL(url);
  need(parsed.protocol === "https:" && ["api.hubapi.com", "www.googleapis.com", "oauth2.googleapis.com"].includes(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port, "unsafe_upstream");
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000), headers: { ...init.headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  need(response.ok && response.status < 300, "upstream_read_failed");
  return z.record(z.string(), z.unknown()).parse(await response.json());
}
async function calendarAccessToken(): Promise<string> {
  const tokens = z.object({ access_token: z.string().optional(), refresh_token: z.string().optional(), expiry_date: z.number().optional() }).passthrough().parse(JSON.parse(await readPrivate(resolve(".local/google/tokens.json"))));
  if (tokens.access_token && tokens.expiry_date && tokens.expiry_date > Date.now() + 60_000) return tokens.access_token;
  let clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  let clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    const file = z.object({ installed: z.object({ client_id: z.string(), client_secret: z.string() }).optional(), web: z.object({ client_id: z.string(), client_secret: z.string() }).optional() }).parse(JSON.parse(await readPrivate(resolve(".local/google/credentials.json"))));
    const credentials = file.installed ?? file.web;
    clientId = credentials?.client_id; clientSecret = credentials?.client_secret;
  }
  need(clientId && clientSecret && tokens.refresh_token, "calendar_authorization_missing");
  const refreshed = await upstream("https://oauth2.googleapis.com/token", undefined, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", client_id: clientId, client_secret: clientSecret, refresh_token: tokens.refresh_token }) });
  return z.string().min(1).parse(refreshed.access_token);
}
export function targetConfiguration(options: Options): TargetConfiguration {
  need(options.testProjectRef && /^[a-z0-9]{20}$/.test(options.testProjectRef), "explicit_test_project_required");
  need(options.testHubspotPortal && /^[0-9]+$/.test(options.testHubspotPortal), "explicit_test_portal_required");
  need(options.testCalendarId && /^[a-f0-9]+@group\.calendar\.google\.com$/.test(options.testCalendarId) && process.env.GOOGLE_CALENDAR_ID === options.testCalendarId, "calendar_target_mismatch");
  need(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.DATABASE_URL && process.env.HUBSPOT_ACCESS_TOKEN, "configuration_missing");
  const supabase = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL);
  need(supabase.origin === `https://${options.testProjectRef}.supabase.co` && supabase.pathname === "/" && !supabase.search && !supabase.hash && !supabase.username && !supabase.password, "supabase_target_mismatch");
  const db = new URL(process.env.DATABASE_URL);
  const connectionKeys = [...db.searchParams.keys()];
  need(connectionKeys.every(key => key === "sslmode" || key === "sslrootcert")
    && new Set(connectionKeys).size === connectionKeys.length, "database_query_override_rejected");
  const direct = db.hostname === `db.${options.testProjectRef}.supabase.co` && decodeURIComponent(db.username) === "postgres";
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(db.hostname) && decodeURIComponent(db.username) === `postgres.${options.testProjectRef}`;
  need(["postgres:", "postgresql:"].includes(db.protocol) && (direct || pooler) && db.pathname === "/postgres", "database_target_mismatch");
  need((db.searchParams.get("sslmode") ?? "verify-full") === "verify-full" && [...db.searchParams.keys()].every(key => !key.startsWith("ssl") || key === "sslmode" || key === "sslrootcert"), "database_tls_required");
  need(!db.searchParams.has("sslrootcert") || db.searchParams.get("sslrootcert")?.startsWith("/"), "database_tls_rootcert_path_required");
  // Let pg load the configured official CA and enforce verify-full hostname/certificate checks.
  db.searchParams.set("sslmode", "verify-full");
  db.searchParams.delete("options");
  need(process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0", "tls_verification_disabled");
  return { projectRef: options.testProjectRef, hubspotPortal: options.testHubspotPortal, calendarId: options.testCalendarId, hubspotToken: process.env.HUBSPOT_ACCESS_TOKEN, connectionString: db.toString() };
}
async function livePreflight(config: TargetConfiguration, pool: PoolClient): Promise<Targets> {
  const account = await upstream("https://api.hubapi.com/account-info/v3/details", config.hubspotToken);
  need(String(account.portalId) === config.hubspotPortal && account.accountType === "DEVELOPER_TEST", "hubspot_target_mismatch");
  const calendarToken = await calendarAccessToken();
  const calendar = await upstream(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId)}/events?maxResults=1`, calendarToken);
  need(calendar.kind === "calendar#events" && Array.isArray(calendar.items), "calendar_readback_mismatch");
  const readOnly = (await pool.query("SELECT current_setting('transaction_read_only') AS read_only")).rows[0];
  need(readOnly?.read_only === "on", "database_read_only_required");
  const publication = await pool.query("SELECT r.policy FROM knowledge_active_release a JOIN knowledge_releases r ON r.id=a.release_id WHERE r.status='ready'");
  need(publication.rows.length === 1, "published_knowledge_required");
  agencyPolicySchema.parse(publication.rows[0].policy);
  return { ...config, calendarToken, pool };
}
async function snapshot(targets: Targets, state: State): Promise<Snapshot> {
  const cookie = state.cookie.match(/^leaddesk_visitor=([a-f0-9-]{36})\.([a-f0-9]{64})$/i);
  need(cookie && cookie[1] === state.conversationId, "state_cookie_mismatch");
  const owner = await targets.pool.query("SELECT id FROM conversations WHERE id=$1 AND token_hash=$2", [state.conversationId, createHash("sha256").update(cookie[2]).digest("hex")]);
  need(owner.rowCount === 1, "server_database_target_mismatch");
  const leads = (await targets.pool.query(`SELECT l.*,c.granted,c.purpose,c.facts_version AS consent_facts_version,c.policy_version AS consent_policy_version FROM lead_submissions l JOIN consents c ON c.id=l.consent_id AND c.conversation_id=l.conversation_id WHERE l.conversation_id=$1`, [state.conversationId])).rows;
  const bookings = (await targets.pool.query(`SELECT b.*,c.granted,c.purpose,c.facts_version AS consent_facts_version,c.policy_version AS consent_policy_version FROM bookings b JOIN consents c ON c.id=b.consent_id AND c.conversation_id=b.conversation_id WHERE b.conversation_id=$1 ORDER BY b.created_at`, [state.conversationId])).rows;
  const operations = (await targets.pool.query("SELECT id,kind,key,status,payload_hash FROM integration_operations WHERE conversation_id=$1 ORDER BY created_at", [state.conversationId])).rows;
  const handoffs = (await targets.pool.query(`SELECT h.id,c.granted,c.purpose FROM handoff_requests h JOIN consents c ON c.id=h.consent_id AND c.conversation_id=h.conversation_id WHERE h.conversation_id=$1`, [state.conversationId])).rows;
  return { leads, bookings, operations, handoffs };
}
function certain(view: PublicChatView, saved: Snapshot): void {
  need(!view.factsValidationPending && !view.safeError && !["unknown", "partial", "failed"].includes(view.crm.status) && (!view.booking || view.booking.status === "booked"), "read_first_unresolved_state");
  need(saved.operations.every(operation => operation.status === "succeeded"), "read_first_unresolved_operation");
}
async function readView(options: Options, state: State, availability = false): Promise<PublicChatView> {
  assertStateTarget(options, state);
  need(state.cookie.match(/^leaddesk_visitor=([a-f0-9-]{36})\.[a-f0-9]{64}$/i)?.[1] === state.conversationId, "state_cookie_mismatch");
  const response = await requestLocal(options, state.cookie, `/api/conversations/${state.conversationId}${availability ? "/availability" : ""}`);
  need(response.ok, "local_read_failed");
  const view = viewSchema.parse(await response.json());
  need(view.conversationId === state.conversationId, "conversation_readback_mismatch");
  return view;
}
async function grounded(targets: Targets, view: PublicChatView, activeOnly = true): Promise<void> {
  // Visitor responses deliberately omit audit metadata. Read it only through the pinned operator READ ONLY transaction.
  const saved = (await targets.pool.query("SELECT state->'messages' AS messages FROM conversations WHERE id=$1", [view.conversationId])).rows[0];
  const messages = z.array(auditMessageSchema).parse(saved?.messages);
  const answer = messages.filter(message => message.role === "assistant" && message.citations?.length).at(-1);
  need(answer?.text && answer.model && answer.citations?.length && view.messages.some(message => message.id === answer.id && message.role === "assistant" && message.text === answer.text), "grounded_answer_required");
  for (const source of answer.citations) {
    const row = (await targets.pool.query(`SELECT c.text,d.title,r.policy FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.release_id=c.release_id JOIN knowledge_releases r ON r.id=c.release_id WHERE c.id=$1 AND c.document_id=$2 AND c.release_id=$3 AND c.visibility='public' AND d.visibility='public' AND r.status='ready' AND (NOT $4::boolean OR EXISTS(SELECT 1 FROM knowledge_active_release a WHERE a.release_id=c.release_id))`, [source.chunkId, source.documentId, source.releaseId, activeOnly])).rows[0];
    need(row && row.title === source.title && (row.text as string).includes(source.excerpt), "citation_readback_mismatch");
  }
}
async function verifyCompleted(targets: Targets, state: State, view: PublicChatView): Promise<Snapshot> {
  const saved = await snapshot(targets, state);
  certain(view, saved);
  need(view.booking?.status === "booked" && view.booking.crmSyncStatus === "succeeded", "completed_state_required");
  // Further chat can change current qualification and factsVersion; it cannot revoke a saved booking.
  await grounded(targets, view, false);
  need(saved.leads.length === 1 && saved.bookings.length === 1, "unexpected_record_count");
  const lead = saved.leads[0], booking = saved.bookings[0];
  assertCompletedVersions(lead, booking);
  const revisions = (await targets.pool.query("SELECT policy FROM knowledge_releases WHERE status='ready' AND policy->>'version'=$1", [lead.policy_version])).rows;
  need(revisions.length > 0 && revisions.every(revision => agencyPolicySchema.parse(revision.policy).version === lead.policy_version), "saved_policy_revision_missing");
  need(saved.operations.find(operation => operation.id === lead.operation_id && operation.kind === "crm")?.key === state.keys.crm && saved.operations.find(operation => operation.id === booking.operation_id && operation.kind === "booking")?.key === state.keys.booking, "frozen_operation_key_mismatch");
  need(lead.status === "saved" && lead.granted && lead.purpose === "crm" && lead.contact_id && lead.note_id && lead.operation_id === view.crm.operationId, "crm_consent_readback_mismatch");
  need(lead.contact.email === state.contact.email && lead.contact.name === state.contact.name && view.contact?.email === state.contact.email, "contact_readback_mismatch");
  need(booking.status === "booked" && booking.crm_sync_status === "succeeded" && booking.granted && booking.purpose === "booking" && booking.calendar_id === targets.calendarId && booking.event_id === view.booking.eventId && booking.operation_id === view.booking.operationId && booking.note_id === lead.note_id, "booking_consent_readback_mismatch");
  need(view.booking.slot && booking.start_utc.toISOString() === view.booking.slot.startUtc && booking.end_utc.toISOString() === view.booking.slot.endUtc && booking.end_utc.getTime() - booking.start_utc.getTime() === 1_800_000, "booking_time_mismatch");
  const contact = await upstream(`https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(lead.contact_id)}?properties=email,firstname`, targets.hubspotToken);
  const properties = z.record(z.string(), z.unknown()).parse(contact.properties);
  need(contact.id === lead.contact_id && !contact.archived && properties.email === state.contact.email && properties.firstname === state.contact.name, "external_contact_mismatch");
  const note = await upstream(`https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(lead.note_id)}?properties=hs_note_body&associations=contacts`, targets.hubspotToken);
  const body = z.string().parse(z.record(z.string(), z.unknown()).parse(note.properties).hs_note_body);
  const associations = z.object({ contacts: z.object({ results: z.array(z.object({ id: z.string() })) }) }).parse(note.associations);
  need(note.id === lead.note_id && !note.archived && body.includes(lead.marker) && body.includes(booking.event_id) && associations.contacts.results.some(item => item.id === lead.contact_id), "external_note_mismatch");
  const event = await upstream(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(targets.calendarId)}/events/${encodeURIComponent(booking.event_id)}`, targets.calendarToken);
  const times = z.object({ start: z.object({ dateTime: z.string() }), end: z.object({ dateTime: z.string() }) }).parse(event);
  need(event.id === booking.event_id && event.status === "confirmed" && Date.parse(times.start.dateTime) === booking.start_utc.getTime() && Date.parse(times.end.dateTime) === booking.end_utc.getTime(), "external_event_mismatch");
  need(!event.attendees && !event.conferenceData && !event.hangoutLink, "unexpected_calendar_invitation");
  return saved;
}
async function dispatch(options: Options, state: State, label: string, payload: ConversationEvent | { acceptedDemoNotice: true }): Promise<PublicChatView> {
  state.intents ??= {};
  need(!state.intents[label], "frozen_request_already_dispatched");
  if (!("acceptedDemoNotice" in payload)) conversationEventSchema.parse(payload);
  state.intents[label] = { payload, status: "dispatching" };
  await saveState(options.statePath, state);
  const response = await requestLocal(options, state.cookie, state.conversationId ? `/api/conversations/${state.conversationId}/events` : "/api/conversations", payload);
  // Capture the new bearer before parsing an uncertain response body.
  if (!state.conversationId) {
    const cookie = response.headers.get("set-cookie")?.split(";")[0];
    const match = cookie?.match(/^leaddesk_visitor=([a-f0-9-]{36})\.([a-f0-9]{64})$/i);
    if (cookie && match) { state.cookie = cookie; state.conversationId = match[1]; await saveState(options.statePath, state); }
  }
  need(response.ok, "mutation_response_failed_read_first");
  const view = viewSchema.parse(await response.json());
  need(view.conversationId === state.conversationId, "mutation_identity_mismatch");
  state.intents[label].status = "acknowledged";
  await saveState(options.statePath, state);
  return view;
}
async function freshScenario(options: Options, state: State, targets: Targets, report: Report): Promise<void> {
  let view = await dispatch(options, state, "create", { acceptedDemoNotice: true });
  let saved = await snapshot(targets, state);
  need(!saved.leads.length && !saved.bookings.length && !saved.handoffs.length && !saved.operations.length, "fresh_thread_not_empty");
  view = await dispatch(options, state, "pricing", { type: "message", text: "What is your Meta Ads management fee and minimum monthly media spend? Please cite the published pricing source. This is a synthetic local acceptance test." });
  await grounded(targets, view);
  report.checks.push("published_pricing_citations_and_model_provenance");
  view = await dispatch(options, state, "ambiguous", { type: "message", text: "I want Meta Ads for a synthetic online stationery shop. My budget is VND 15 million per month, but I have not decided whether that means media spend alone or total including your management fee. Do not assume the budget basis." });
  need(view.qualification.status === "needs_info" && !view.allowedActions.includes("select_slot") && !view.allowedActions.includes("confirm_slot"), "ambiguous_budget_gate_failed");
  saved = await snapshot(targets, state); certain(view, saved);
  need(!saved.leads.length && !saved.bookings.length && !saved.operations.length && view.crm.status === "none", "write_before_consent");
  report.checks.push("ambiguous_budget_needs_info_no_crm_or_booking");
  view = await dispatch(options, state, "qualified", { type: "message", text: `Here are my explicit final requirements: Meta Ads management for a synthetic online stationery shop, with an existing website. My TOTAL monthly budget is VND 15,000,000 including BOTH VND 5,000,000 management fee and VND 10,000,000 media spend, not media-only. Start date ${state.startDate}. I have no special requirements. I have not yet submitted contact details or consented to CRM storage.` });
  const publication = (await targets.pool.query("SELECT r.policy FROM knowledge_active_release a JOIN knowledge_releases r ON r.id=a.release_id")).rows[0];
  const policy = agencyPolicySchema.parse(publication?.policy);
  need(view.facts.service === "meta_ads" && view.facts.business && view.facts.hasWebsite === true && view.facts.startDate === state.startDate && view.facts.budget.kind === "total" && view.facts.budget.totalMonthlyVnd === 15_000_000 && qualify(view.facts, policy, agencyToday()).status === "qualified" && view.qualification.status === "qualified" && view.policyVersion === policy.version && view.allowedActions.includes("submit_contact"), "explicit_facts_qualification_failed");
  saved = await snapshot(targets, state); certain(view, saved);
  need(!saved.leads.length && !saved.bookings.length && !saved.operations.length && !view.slots.length && !view.allowedActions.includes("select_slot"), "crm_consent_gate_failed");
  report.checks.push("explicit_facts_and_no_crm_before_consent");
  view = await dispatch(options, state, "crm", { type: "submit_contact", contact: state.contact, consent: true, factsVersion: view.factsVersion, key: state.keys.crm });
  saved = await snapshot(targets, state); certain(view, saved);
  need(view.crm.status === "saved" && saved.leads.length === 1 && saved.leads[0].granted && saved.leads[0].purpose === "crm" && !saved.bookings.length && view.allowedActions.includes("select_slot"), "crm_saved_required_before_slots");
  report.checks.push("explicit_crm_consent_and_saved_before_slots");
  view = await readView(options, state, true);
  need(view.slots.length > 0 && view.crm.status === "saved" && !view.booking, "verified_slots_required");
  const slot = view.slots[0];
  need(Date.parse(slot.endUtc) - Date.parse(slot.startUtc) === 1_800_000, "slot_duration_mismatch");
  view = await dispatch(options, state, "select", { type: "select_slot", startUtc: slot.startUtc });
  saved = await snapshot(targets, state); certain(view, saved);
  need(view.selectedSlot?.startUtc === slot.startUtc && !view.booking && !saved.bookings.length && !saved.operations.some(item => item.kind === "booking") && view.allowedActions.includes("confirm_slot"), "selection_created_booking");
  report.checks.push("slot_selection_without_booking");
  view = await dispatch(options, state, "booking", { type: "confirm_slot", startUtc: slot.startUtc, factsVersion: view.factsVersion, confirmed: true, key: state.keys.booking });
  const before = await verifyCompleted(targets, state, view);
  report.checks.push("explicit_confirmation_and_external_contact_note_event_readback");
  view = await dispatch(options, state, "handoff", { type: "request_handoff", contact: state.contact, consent: true, reason: "Synthetic local acceptance: please review this already booked test consultation; no real customer.", key: state.keys.handoff });
  need(view.handoff?.status === "saved", "handoff_not_saved");
  const resumed = await readView(options, state);
  const after = await verifyCompleted(targets, state, resumed);
  need(after.handoffs.length === 1 && after.handoffs[0].id === resumed.handoff?.handoffId && after.handoffs[0].granted && after.handoffs[0].purpose === "handoff", "handoff_consent_readback_mismatch");
  need(before.leads[0].contact_id === after.leads[0].contact_id && before.leads[0].note_id === after.leads[0].note_id && before.bookings[0].event_id === after.bookings[0].event_id, "resume_ids_changed");
  // Replay only acknowledged, frozen successful requests; never retry an ambiguous dispatch.
  for (const label of ["crm", "booking", "handoff"] as const) {
    const frozen = state.intents?.[label];
    need(frozen?.status === "acknowledged", "replay_requires_acknowledgment");
    const payload = conversationEventSchema.parse(frozen.payload);
    view = await dispatch(options, state, `replay_${label}`, payload);
    need(view.crm.operationId === resumed.crm.operationId && view.booking?.eventId === resumed.booking?.eventId && view.handoff?.handoffId === resumed.handoff?.handoffId, "replay_ids_changed");
  }
  const replayed = await verifyCompleted(targets, state, await readView(options, state));
  need(replayed.operations.length === after.operations.length && replayed.handoffs.length === 1, "replay_created_records");
  report.checks.push("single_handoff_resume_and_same_key_replays_preserve_ids");
  state.completed = true; await saveState(options.statePath, state);
  report.mode = "fresh-full-scenario"; report.fullScenarioExecuted = true; report.status = "verified";
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const report: Report = { version: 1, mode: "preflight-only", status: "blocked", checks: [], fullScenarioExecuted: false };
  let options: Options | undefined, state: State | undefined, targets: Targets | undefined, pool: Pool | undefined, client: PoolClient | undefined;
  try {
    options = parseOptions(argv);
    try { state = stateSchema.parse(JSON.parse(await readPrivate(options.statePath))); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    if (state) {
      assertStateTarget(options, state);
      need(state.contact.email.endsWith("@example.com"), "synthetic_contact_required");
      if (state.conversationId) {
        report.mode = "read-only-resume";
        const view = await readView(options, state);
        report.checks.push("same_origin_authenticated_conversation_get");
        need(Object.values(state.intents ?? {}).every(intent => intent.status === "acknowledged"), "read_first_unresolved_request");
        if (options.preflightOnly || (!options.testProjectRef && !options.testHubspotPortal && !options.testCalendarId)) {
          need(!view.factsValidationPending && !view.safeError && !["unknown", "partial", "failed"].includes(view.crm.status) && (!view.booking || view.booking.status === "booked" && view.booking.crmSyncStatus === "succeeded"), "read_first_unresolved_state");
          report.status = "preflight-only";
          return;
        }
      } else throw new Stop("create_outcome_unknown_do_not_repeat");
    }
    if (options.preflightOnly || !options.allowTestWrites && !state) {
      report.checks.push("no_http_mutations_or_model_calls");
      report.status = "preflight-only";
      // Configuration-only: absence is reported, never mislabeled as a live account proof.
      targetConfiguration(options);
      report.checks.push("explicit_target_configuration_matches_environment_not_live_verified");
      return;
    }
    if (!state) need(options.serverUsesThisEnv, "server-uses-this-env_required");
    const config = targetConfiguration(options);
    if (state?.targets) need(state.targets.projectRef === config.projectRef && state.targets.hubspotPortal === config.hubspotPortal && state.targets.calendarId === config.calendarId, "state_account_mismatch");
    pool = new Pool({ connectionString: config.connectionString, max: 1, connectionTimeoutMillis: 10_000 });
    client = await pool.connect();
    // Session poolers can discard startup GUC options; pin every SELECT to this explicit transaction.
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY");
    await client.query("SET LOCAL statement_timeout = '15s'");
    targets = await livePreflight(config, client);
    report.checks.push("live_developer_test_portal_dedicated_calendar_and_published_database");
    if (state?.conversationId) {
      const view = await readView(options, state);
      const saved = await snapshot(targets, state);
      certain(view, saved);
      need(view.booking?.status === "booked", "incomplete_resume_read_first_stop_no_redispatch");
      await verifyCompleted(targets, state, view);
      report.mode = "completed-state-verification"; report.status = "verified";
      report.checks.push("existing_completed_thread_external_ids_consent_and_remote_readback_no_posts");
      return;
    }
    need(options.allowTestWrites, "allow-test-writes_required");
    report.checks.push("operator_asserted_running_server_uses_this_environment_not_independently_verified");
    const startDate = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);
    state ??= { version: 1, baseUrl: options.baseUrl, conversationId: "", cookie: "", keys: { crm: randomUUID(), booking: randomUUID(), handoff: randomUUID() }, contact: { name: "LeadDesk Synthetic Acceptance", email: `leaddesk-smoke-${randomUUID()}@example.com` }, startDate, intents: {}, targets: { projectRef: config.projectRef, hubspotPortal: config.hubspotPortal, calendarId: config.calendarId } };
    await saveState(options.statePath, state, true);
    report.mode = "fresh-full-scenario";
    await freshScenario(options, state, targets, report);
  } catch (error) {
    report.status = "blocked";
    report.code = error instanceof Stop ? error.code : "private_details_suppressed";
    // Read once after any uncertainty; never reconcile, re-dispatch, rotate keys or replace accounts.
    if (options && state?.conversationId) {
      try {
        await readView(options, state);
        if (targets) await snapshot(targets, state);
        report.checks.push("read_first_after_stop_no_redispatch");
      } catch { report.checks.push("read_first_unavailable_preserve_private_state"); }
    }
    process.exitCode = 1;
  } finally {
    if (client) {
      try { await client.query("ROLLBACK"); }
      catch {
        report.status = "blocked"; report.code ??= "read_only_transaction_close_failed"; process.exitCode = 1;
      } finally { client.release(); }
    }
    await pool?.end();
    // Only hand-selected facts; no payload, cookie, email, provider response, IDs or raw errors.
    const directory = resolve("artifacts/evidence");
    await mkdir(directory, { recursive: true });
    const path = resolve(directory, `smoke-local-${randomUUID()}.json`);
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try { await handle.writeFile(JSON.stringify(report, null, 2) + "\n"); } finally { await handle.close(); }
    console.log(JSON.stringify({ ...report, report: relative(process.cwd(), path) }));
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('{"status":"blocked","code":"report_or_private_storage_unavailable","fullScenarioExecuted":false}'); process.exitCode = 1; });
}
