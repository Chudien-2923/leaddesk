import { getPool } from "@/server/db/pool";
import { handleAdmin, safeJson } from "@/server/http/guards";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const result = await getPool().query(`SELECT id AS "releaseId", status, failure_code AS "failureCode", created_at AS "createdAt", published_at AS "publishedAt" FROM knowledge_releases WHERE admin_id=$1 AND status <> 'draft' ORDER BY created_at DESC LIMIT 20`, [admin.userId]);
    return safeJson({ publications: result.rows }, { headers: admin.headers });
  });
}
