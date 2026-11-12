import { getPool } from "@/server/db/pool";
import { handleAdmin, safeJson } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const result = await getPool().query(
      `SELECT o.id, o.conversation_id AS "conversationId", o.kind,
       CASE WHEN o.kind='crm' AND o.status='failed' AND l.status='partial' THEN 'partial' ELSE o.status END AS status,
       o.safe_error_code AS "safeCode", o.created_at AS "createdAt", o.updated_at AS "updatedAt",
       CASE WHEN l.operation_id IS NOT NULL THEN json_build_object(
         'contactSaved', l.contact_id IS NOT NULL, 'noteSaved', l.note_id IS NOT NULL
       ) ELSE NULL END AS "crmProgress"
       FROM integration_operations o
       LEFT JOIN lead_submissions l ON o.kind='crm' AND l.operation_id=o.id AND l.conversation_id=o.conversation_id
       ORDER BY o.updated_at DESC LIMIT 100`,
    );
    return safeJson({ operations: result.rows, limit: 100 }, { headers: admin.headers });
  });
}
