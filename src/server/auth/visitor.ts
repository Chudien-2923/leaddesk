import "server-only";
import { parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { assertConversationOwner, ownerTokenHash, type ConversationOwner } from "../db/conversations";
import { getPool } from "../db/pool";

export const VISITOR_COOKIE_NAME = "leaddesk_visitor";

export function createVisitorCookie(owner: { id: string; token: string }, request: Request): string {
  ownerTokenHash({ conversationId: owner.id, token: owner.token });
  // The 256-bit bearer authenticates the ID through its stored hash; no unsigned ID is trusted.
  return serializeCookieHeader(VISITOR_COOKIE_NAME, `${owner.id}.${owner.token}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: new URL(request.url).protocol === "https:",
    path: "/",
  });
}

export async function requireVisitor(request: Request): Promise<ConversationOwner> {
  const cookies = parseCookieHeader(request.headers.get("cookie") ?? "")
    .filter((cookie) => cookie.name === VISITOR_COOKIE_NAME);
  const match = cookies.length === 1 ? cookies[0].value.match(/^([a-f0-9-]{36})\.([a-f0-9]{64})$/i) : null;
  if (!match) throw Object.assign(new Error("Visitor authentication required"), { code: "CONVERSATION_FORBIDDEN" });
  const owner = { conversationId: match[1], token: match[2] };
  await assertConversationOwner(getPool(), owner);
  return owner;
}
