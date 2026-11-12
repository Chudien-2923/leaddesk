import { z } from "zod";
import { createReleaseRepository } from "@/server/db/releases";
import { getPool } from "@/server/db/pool";
import { publishKnowledge } from "@/server/knowledge/publish";
import { handleAdmin, knowledgeInputSchema, parseInput, readMutationJson, safeJson, uuidSchema } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const publishSchema = z.union([knowledgeInputSchema, z.object({ releaseId: uuidSchema }).strict()]);
export async function POST(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const input = parseInput(publishSchema, await readMutationJson(request, 512_000));
    const source = "releaseId" in input
      ? await createReleaseRepository(getPool()).getDraft(input.releaseId, admin.userId)
      : input;
    // The publisher creates a new immutable preparation release. The source draft stays a draft.
    const result = await publishKnowledge({ documents: source.documents, policy: source.policy }, admin.userId);
    return safeJson({ releaseId: result.releaseId, state: result.status }, { status: result.status === "ready" ? 201 : 503, headers: admin.headers });
  });
}
