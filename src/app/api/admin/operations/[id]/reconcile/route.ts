import { z } from "zod";
import { reconcileBooking } from "@/server/booking/reconcile";
import { getPool } from "@/server/db/pool";
import { createConfiguredCalendarClient } from "@/server/integrations/google-calendar";
import { createHubSpotClient } from "@/server/integrations/hubspot";
import { createAdminCrmUpdater, reconcileCrm, reconcileCrmBooking } from "@/server/leads/crm";
import { handleAdmin, HttpError, parseInput, readMutationJson, safeJson, uuidSchema } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type JournalRow = { id: string; conversationId: string; kind: "crm" | "booking" | "crm_booking_update" | "handoff"; status: string; safeCode: string | null };
const columns = 'id, conversation_id AS "conversationId", kind, status, safe_error_code AS "safeCode"';
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleAdmin(request, async admin => {
    parseInput(z.object({}).strict(), await readMutationJson(request));
    const id = parseInput(uuidSchema, (await context.params).id);
    const pool = getPool();
    const read = () => pool.query<JournalRow>(`SELECT ${columns} FROM integration_operations WHERE id=$1`, [id]);
    const operation = (await read()).rows[0];
    if (!operation) throw new HttpError("OPERATION_NOT_FOUND", 404);
    switch (operation.kind) {
      case "crm":
        await reconcileCrm(id, admin.userId);
        break;
      case "crm_booking_update":
        await reconcileCrmBooking(id, admin.userId);
        break;
      case "booking": {
        const calendarId = process.env.GOOGLE_CALENDAR_ID;
        const token = process.env.HUBSPOT_ACCESS_TOKEN;
        if (!calendarId?.trim() || calendarId.trim().toLowerCase() === "primary" || calendarId !== calendarId.trim() || !token?.trim()) throw new HttpError("SERVICE_UNAVAILABLE", 503);
        const calendar = await createConfiguredCalendarClient();
        const leadService = createAdminCrmUpdater({ pool, adminId: admin.userId, conversationId: operation.conversationId, hubspot: createHubSpotClient({ token }) });
        await reconcileBooking(id, admin.userId, { pool, calendar, calendarId, leadService });
        break;
      }
      case "handoff": {
        const result = await pool.query('SELECT id, status FROM handoff_requests WHERE operation_id=$1', [id]);
        return safeJson({ error: { code: "OPERATION_NOT_RECONCILABLE" }, operation, handoff: result.rows[0] ?? null }, { status: 409, headers: admin.headers });
      }
    }
    return safeJson({ operation: (await read()).rows[0] }, { headers: admin.headers });
  });
}
