import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { withDatabaseConnection } from "../db/pool";
import { recoverExistingBooking, type BookingRecoveryDependencies, type BookingResult } from "./service";

// The route must first call requireAdmin (Supabase getUser verification). The injected
// CRM capability is createAdminCrmUpdater bound to this operation's conversation.
export async function reconcileBooking(operationId: string, adminId: string, dependencies: BookingRecoveryDependencies): Promise<BookingResult> {
  const configured = z.string().uuid().safeParse(process.env.ADMIN_USER_ID);
  if (!configured.success || adminId !== configured.data) throw Object.assign(new Error("Administrator access denied"), { code: "ADMIN_UNAUTHORIZED" });
  z.string().uuid().parse(operationId);
  if (!dependencies.calendarId?.trim() || dependencies.calendarId.trim().toLowerCase() === "primary") throw Object.assign(new Error("Dedicated calendar required"), { code: "CALENDAR_CONFIGURATION" });
  const client = await dependencies.pool.connect();
  let lockKey: string | undefined;
  let discard = false;
  try {
    const operation = await client.query<{ conversation_id: string }>("SELECT conversation_id FROM integration_operations WHERE id = $1 AND kind = 'booking'", [operationId]);
    const conversationId = operation.rows[0]?.conversation_id;
    if (!conversationId) throw Object.assign(new Error("Booking operation unavailable"), { code: "OPERATION_FORBIDDEN" });
    const key = createHash("sha256").update(conversationId.toLowerCase()).digest().readBigInt64BE().toString();
    let acquired;
    try { acquired = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS locked", [key]); }
    catch (error) { discard = true; throw error; }
    if (!acquired.rows[0].locked) throw Object.assign(new Error("Conversation is busy"), { code: "CONVERSATION_BUSY" });
    lockKey = key;
    return await withDatabaseConnection(dependencies.pool, client, () => recoverExistingBooking(dependencies, operationId, conversationId));
  } finally {
    try {
      if (lockKey) {
        try {
          const result = await client.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock($1::bigint) AS unlocked", [lockKey]);
          if (!result.rows[0].unlocked) { discard = true; throw new Error("Conversation lock was not released"); }
        } catch (error) { discard = true; throw error; }
      }
    } finally { client.release(discard); }
  }
}
