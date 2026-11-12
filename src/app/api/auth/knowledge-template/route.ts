import { readFile } from "node:fs/promises";
import path from "node:path";
import { agencyPolicySchema } from "@/domain/policy";
import { createReleaseRepository, KnowledgeNotReadyError } from "@/server/db/releases";
import { getPool } from "@/server/db/pool";
import { handleAdmin, safeJson } from "@/server/http/guards";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const pool = getPool();
    try {
      const active = await createReleaseRepository(pool).getActiveRelease();
      const documents = await pool.query('SELECT title, body, kind, visibility FROM knowledge_documents WHERE release_id=$1 ORDER BY id', [active.releaseId]);
      return safeJson({ documents: documents.rows, policy: active.policy }, { headers: admin.headers });
    } catch (error) { if (!(error instanceof KnowledgeNotReadyError)) throw error; }
    const policy = agencyPolicySchema.parse(JSON.parse(await readFile(path.resolve("data/agency/qualification.json"), "utf8")));
    const sources = [["services", "Agency services"], ["pricing", "Pricing and requirements"], ["faq", "Frequently asked questions"], ["policies", "Agency policies"]] as const;
    const documents = await Promise.all(sources.map(async ([kind, title]) => ({ title, kind, visibility: "public", body: await readFile(path.resolve("data/agency", kind === "policies" ? "policies.md" : kind + ".md"), "utf8") })));
    return safeJson({ documents, policy }, { headers: admin.headers });
  });
}
