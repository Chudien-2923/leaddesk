import { z } from "zod";
import { getPool } from "@/server/db/pool";
import { handleAdmin, HttpError, parseInput, readMutationJson, safeJson, uuidSchema } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const patchSchema = z.object({ id: uuidSchema, status: z.enum(["acknowledged", "resolved"]) }).strict();
const columns = 'id, conversation_id AS "conversationId", contact, reason, status, created_at AS "createdAt", updated_at AS "updatedAt"';
export async function GET(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const result = await getPool().query(`SELECT ${columns} FROM handoff_requests ORDER BY created_at DESC LIMIT 100`);
    return safeJson({ handoffs: result.rows, limit: 100 }, { headers: admin.headers });
  });
}
export async function PATCH(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const { id, status } = parseInput(patchSchema, await readMutationJson(request));
    const result = await getPool().query(`UPDATE handoff_requests SET status=$2,updated_at=now() WHERE id=$1 RETURNING ${columns}`, [id, status]);
    if (!result.rowCount) throw new HttpError("HANDOFF_NOT_FOUND", 404);
    return safeJson({ handoff: result.rows[0] }, { headers: admin.headers });
  });
}
