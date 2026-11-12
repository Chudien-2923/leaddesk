import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { agencyPolicySchema } from "../../domain/policy";
import { requireAdmin, type AdminIdentity } from "../auth/admin";
import { requireVisitor } from "../auth/visitor";
import type { ConversationOwner } from "../db/conversations";
import { getPool } from "../db/pool";

export class HttpError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export function requireLocalOrigin(request: Request): URL {
  const target = new URL(request.url);
  if (!['http:', 'https:'].includes(target.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)) {
    throw new HttpError("ORIGIN_FORBIDDEN", 403);
  }
  // Next may canonicalize Request.url to localhost; browser Origin follows the real Host.
  // Only a literal loopback authority is accepted. Forwarded headers never grant trust.
  const host = request.headers.get("host");
  if (host !== null) {
    if (!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) throw new HttpError("ORIGIN_FORBIDDEN", 403);
    try { target.host = new URL(`${target.protocol}//${host}`).host; }
    catch { throw new HttpError("ORIGIN_FORBIDDEN", 403); }
  }
  const origin = request.headers.get("origin");
  if (!origin || origin !== target.origin) throw new HttpError("ORIGIN_FORBIDDEN", 403);
  return target;
}

export async function readMutationJson(request: Request, maxBytes = 16_384): Promise<unknown> {
  requireLocalOrigin(request);
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new HttpError("JSON_REQUIRED", 415);
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new HttpError("SERVICE_UNAVAILABLE", 503);
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpError("BODY_TOO_LARGE", 413);
  if (!request.body) throw new HttpError("INVALID_JSON", 400);
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError("BODY_TOO_LARGE", 413);
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError("INVALID_JSON", 400);
  } finally { reader.releaseLock(); }
}

export function safeJson(data: unknown, options: { status?: number; headers?: HeadersInit } = {}): Response {
  const headers = new Headers(options.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(data), { status: options.status ?? 200, headers });
}

const safeStatuses: Readonly<Record<string, number>> = {
  ADMIN_UNAUTHORIZED: 401, CONVERSATION_FORBIDDEN: 403, OPERATION_FORBIDDEN: 404,
  CONVERSATION_NOT_FOUND: 404, CRM_OPERATION_NOT_FOUND: 404, KNOWLEDGE_NOT_READY: 503,
  CONVERSATION_BUSY: 409, OPERATION_PAYLOAD_CONFLICT: 409, CRM_RECONCILIATION_STALE: 409,
  CRM_LEAD_NOT_SAVED: 409, BOOKING_STALE: 409, SLOT_UNAVAILABLE: 409,
  DRAFT_REQUEST_CONFLICT: 409,
};
export function safeHttpError(error: unknown, headers?: HeadersInit): Response {
  if (error instanceof HttpError) return safeJson({ error: { code: error.code } }, { status: error.status, headers });
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  const status = safeStatuses[code];
  return safeJson({ error: { code: status ? code : "SERVICE_UNAVAILABLE" } }, { status: status ?? 503, headers });
}
export async function handleHttp(action: () => Promise<Response>): Promise<Response> {
  try { return await action(); } catch (error) { return safeHttpError(error); }
}
export async function handleAdmin(request: Request, action: (admin: AdminIdentity) => Promise<Response>): Promise<Response> {
  let headers: Headers | undefined;
  try {
    const admin = await requireAdmin(request);
    headers = admin.headers;
    return await action(admin);
  } catch (error) { return safeHttpError(error, headers); }
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError("INVALID_REQUEST", 400);
  return parsed.data;
}
export const uuidSchema = z.string().uuid();
export async function requirePathOwner(request: Request, id: string): Promise<ConversationOwner> {
  const pathId = parseInput(uuidSchema, id);
  const owner = await requireVisitor(request);
  if (owner.conversationId.toLowerCase() !== pathId.toLowerCase()) throw new HttpError("CONVERSATION_FORBIDDEN", 403);
  return owner;
}

export async function consumeRateLimit(scope: "message" | "creation", subject: string): Promise<void> {
  const key = createHash("sha256").update(subject).digest("hex");
  const limit = scope === "message" ? 20 : 5;
  // One statement is one short transaction; concurrent processes cannot overspend a counter.
  const result = await getPool().query(
    `INSERT INTO leaddesk_private.http_rate_limits(scope,key_hash,window_start,used)
     VALUES($1,$2,statement_timestamp(),1)
     ON CONFLICT(scope,key_hash) DO UPDATE SET
       window_start=CASE WHEN http_rate_limits.window_start <= statement_timestamp()-interval '1 hour' THEN statement_timestamp() ELSE http_rate_limits.window_start END,
       used=CASE WHEN http_rate_limits.window_start <= statement_timestamp()-interval '1 hour' THEN 1 ELSE http_rate_limits.used+1 END
     WHERE http_rate_limits.window_start <= statement_timestamp()-interval '1 hour' OR http_rate_limits.used < $3
     RETURNING used`, [scope, key, limit],
  );
  if (!result.rowCount) throw new HttpError("RATE_LIMITED", 429);
}

export const knowledgeInputSchema = z.object({
  documents: z.array(z.object({
    documentId: z.string().uuid().optional(),
    title: z.string().trim().min(1).max(256),
    body: z.string().refine(value => !!value.trim() && Array.from(value).length <= 20_000),
    kind: z.enum(["services", "pricing", "faq", "policies"]).optional(),
    visibility: z.enum(["public", "internal"]).optional(),
  }).strict()).min(1).max(100),
  policy: agencyPolicySchema,
}).strict();
export async function limitConversationCreation(request: Request): Promise<void> {
  requireLocalOrigin(request);
  // Next's Request exposes no verified socket peer. Never trust X-Forwarded-For/X-Real-IP.
  // This loopback-only deployment deliberately shares one hashed peer scope across hosts/ports,
  // cookies and processes: at most five new conversations per hour for the local installation.
  await consumeRateLimit("creation", "leaddesk:verified-loopback:shared-peer");
}
