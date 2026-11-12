import { z } from "zod";
import { createReleaseRepository, KnowledgeNotReadyError } from "@/server/db/releases";
import { getPool } from "@/server/db/pool";
import { handleAdmin, knowledgeInputSchema, parseInput, readMutationJson, safeJson, uuidSchema } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const updateSchema = knowledgeInputSchema.extend({ releaseId: uuidSchema }).strict();
const createSchema = updateSchema.refine(input => input.documents.every(document => document.documentId !== undefined));
const deleteSchema = z.object({ releaseId: uuidSchema }).strict();

export async function GET(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const repository = createReleaseRepository(getPool());
    const drafts = await repository.listDrafts(admin.userId);
    let active: { status: "ready"; releaseId: string } | { status: "not_ready"; releaseId: null };
    try { active = { status: "ready", releaseId: (await repository.getActiveRelease()).releaseId }; }
    catch (error) {
      if (!(error instanceof KnowledgeNotReadyError)) throw error;
      active = { status: "not_ready", releaseId: null };
    }
    return safeJson({ drafts, active }, { headers: admin.headers });
  });
}
export async function POST(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const { releaseId, ...input } = parseInput(createSchema, await readMutationJson(request, 512_000));
    const draft = await createReleaseRepository(getPool()).createDraft(input, admin.userId, releaseId);
    return safeJson(draft, { status: 201, headers: admin.headers });
  });
}
export async function PATCH(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const { releaseId, ...input } = parseInput(updateSchema, await readMutationJson(request, 512_000));
    const draft = await createReleaseRepository(getPool()).updateDraft(releaseId, input, admin.userId);
    return safeJson(draft, { headers: admin.headers });
  });
}
export async function DELETE(request: Request): Promise<Response> {
  return handleAdmin(request, async admin => {
    const { releaseId } = parseInput(deleteSchema, await readMutationJson(request));
    await createReleaseRepository(getPool()).deleteDraft(releaseId, admin.userId);
    return safeJson({ releaseId, deleted: true }, { headers: admin.headers });
  });
}
