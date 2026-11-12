import "server-only";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { agencyPolicySchema, type AgencyPolicy } from "../../domain/policy";
import { E5_DIMENSIONS, E5_MODEL_ID, E5_MODEL_REVISION } from "../knowledge/embedding";
import type { ChunkDraft } from "../knowledge/chunking";
import { getPool, getQueryExecutor } from "./pool";

export interface KnowledgeDraft {
  documentId?: string;
  title: string;
  body: string;
  kind?: "services" | "pricing" | "faq" | "policies";
  visibility?: "public" | "internal";
}
export interface KnowledgeDocument extends KnowledgeDraft {
  documentId: string;
  kind: "services" | "pricing" | "faq" | "policies";
  visibility: "public" | "internal";
}
export interface KnowledgeInput { documents: KnowledgeDraft[]; policy: AgencyPolicy }
export interface KnowledgeRelease {
  releaseId: string;
  status: "draft" | "preparing" | "ready" | "failed";
  policy: AgencyPolicy;
  documents: KnowledgeDocument[];
}
export interface PreparedDocument { documentId: string; chunks: Array<ChunkDraft & { embedding: number[] }> }
export interface ActiveRelease { releaseId: string; policy: AgencyPolicy }
export type PublicationFailureCode = "KNOWLEDGE_PREPARATION_FAILED" | "POLICY_VERSION_CONFLICT";
export class KnowledgeNotReadyError extends Error {
  readonly code = "KNOWLEDGE_NOT_READY";
  constructor() { super("No compatible ready knowledge release is active"); this.name = "KnowledgeNotReadyError"; }
}
export interface ReleaseRepository {
  createDraft(input: KnowledgeInput, adminId: string, releaseId?: string): Promise<KnowledgeRelease>;
  listDrafts(adminId: string): Promise<KnowledgeRelease[]>;
  getDraft(releaseId: string, adminId: string): Promise<KnowledgeRelease>;
  updateDraft(releaseId: string, input: KnowledgeInput, adminId: string): Promise<KnowledgeRelease>;
  deleteDraft(releaseId: string, adminId: string): Promise<void>;
  beginPreparation(releaseId: string, adminId: string): Promise<KnowledgeRelease>;
  commitPreparedRelease(releaseId: string, documents: PreparedDocument[], adminId: string): Promise<void>;
  failPreparation(releaseId: string, adminId: string, failureCode?: PublicationFailureCode): Promise<"failed" | "ready">;
  getActiveRelease(): Promise<ActiveRelease>;
}
const adminSchema = z.string().trim().min(1).max(256);
const idSchema = z.string().uuid();
const documentSchema = z.object({
  documentId: idSchema.optional(), title: z.string().trim().min(1).max(256),
  body: z.string().refine(value => !!value.trim() && Array.from(value).length <= 20_000, "Document must contain 1–20000 characters"),
  kind: z.enum(["services", "pricing", "faq", "policies"]).default("services"),
  visibility: z.enum(["public", "internal"]).default("public"),
}).strict();
const inputSchema = z.object({ documents: z.array(documentSchema).min(1), policy: agencyPolicySchema }).strict();
type ReleaseRow = { id: string; status: KnowledgeRelease["status"]; policy: AgencyPolicy };
type DocumentRow = { id: string; title: string; body: string; kind: KnowledgeDocument["kind"]; visibility: KnowledgeDocument["visibility"] };
function canonicalDraftInput(input: KnowledgeInput): string {
  const value = inputSchema.parse({ documents: input.documents, policy: input.policy });
  value.documents.sort((left, right) => (left.documentId ?? "").toLowerCase().localeCompare((right.documentId ?? "").toLowerCase()));
  return JSON.stringify({
    documents: value.documents.map(document => ({ ...document, documentId: document.documentId?.toLowerCase() })),
    policy: value.policy,
  });
}
function draftRequestConflict(): Error & { code: string } {
  return Object.assign(new Error("Draft request ID already represents different content or ownership"), { code: "DRAFT_REQUEST_CONFLICT" });
}

async function transaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* Preserve the transaction's original error. */ }
    throw error;
  } finally { client.release(); }
}
async function readRelease(executor: Pool | PoolClient, releaseId: string, adminId: string): Promise<KnowledgeRelease> {
  const result = await executor.query<ReleaseRow>("SELECT id, status, policy FROM knowledge_releases WHERE id = $1 AND admin_id = $2", [releaseId, adminId]);
  if (!result.rowCount) throw new Error("Knowledge release not found for admin");
  const documents = await executor.query<DocumentRow>("SELECT id, title, body, kind, visibility FROM knowledge_documents WHERE release_id = $1 ORDER BY id", [releaseId]);
  return {
    releaseId, status: result.rows[0].status, policy: agencyPolicySchema.parse(result.rows[0].policy),
    documents: documents.rows.map(row => ({ documentId: row.id, title: row.title, body: row.body, kind: row.kind, visibility: row.visibility })),
  };
}
async function insertDocuments(client: PoolClient, releaseId: string, documents: KnowledgeDocument[]): Promise<void> {
  for (const document of documents) {
    await client.query("INSERT INTO knowledge_documents (id, release_id, title, body, kind, visibility) VALUES ($1, $2, $3, $4, $5, $6)",
      [document.documentId, releaseId, document.title, document.body, document.kind, document.visibility]);
  }
}

/** Server-only: adminId must originate from the authenticated allowlisted admin boundary. */
export function createReleaseRepository(pool: Pool): ReleaseRepository {
  return {
    async createDraft(input, adminId, releaseId) {
      adminSchema.parse(adminId);
      const value = inputSchema.parse(input);
      const id = releaseId === undefined ? randomUUID() : idSchema.parse(releaseId).toLowerCase();
      const documents = value.documents.map(document => ({ ...document, documentId: (document.documentId ?? randomUUID()).toLowerCase() }));
      if (releaseId !== undefined) documents.sort((left, right) => left.documentId.localeCompare(right.documentId));
      if (new Set(documents.map(document => document.documentId)).size !== documents.length) throw new Error("Duplicate knowledge document IDs");
      return transaction<KnowledgeRelease>(pool, async client => {
        const result = await client.query<{ id: string }>("INSERT INTO knowledge_releases (id, admin_id, policy, model_id, model_revision, dimensions) VALUES ($1,$2,$3::jsonb,$4,$5,$6) ON CONFLICT (id) DO NOTHING RETURNING id",
          [id, adminId, JSON.stringify(value.policy), E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS]);
        if (result.rowCount) {
          await insertDocuments(client, id, documents);
          return { releaseId: id, status: "draft", policy: value.policy, documents };
        }
        // ON CONFLICT waits for a concurrent first save. This statement sees its committed result.
        const owner = await client.query<{ admin_id: string; status: KnowledgeRelease["status"] }>("SELECT admin_id, status FROM knowledge_releases WHERE id=$1 FOR UPDATE", [id]);
        if (!owner.rowCount || owner.rows[0].admin_id !== adminId || owner.rows[0].status !== "draft") throw draftRequestConflict();
        const existing = await readRelease(client, id, adminId);
        if (canonicalDraftInput(existing) !== canonicalDraftInput({ documents, policy: value.policy })) throw draftRequestConflict();
        return existing;
      });
    },
    async listDrafts(adminId) {
      adminSchema.parse(adminId);
      const executor = getQueryExecutor(pool);
      const rows = await executor.query<{ id: string }>("SELECT id FROM knowledge_releases WHERE admin_id = $1 AND status = 'draft' ORDER BY created_at DESC", [adminId]);
      return Promise.all(rows.rows.map(row => readRelease(executor, row.id, adminId)));
    },
    async getDraft(releaseId, adminId) {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      const release = await readRelease(getQueryExecutor(pool), releaseId, adminId);
      if (release.status !== "draft") throw new Error("Knowledge release is not an editable draft");
      return release;
    },
    async updateDraft(releaseId, input, adminId) {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      const value = inputSchema.parse(input);
      const documents = value.documents.map(document => ({ ...document, documentId: document.documentId ?? randomUUID() }));
      if (new Set(documents.map(document => document.documentId)).size !== documents.length) throw new Error("Duplicate knowledge document IDs");
      return transaction(pool, async client => {
        const updated = await client.query("UPDATE knowledge_releases SET policy = $3::jsonb, updated_at = now() WHERE id = $1 AND admin_id = $2 AND status = 'draft' RETURNING id", [releaseId, adminId, JSON.stringify(value.policy)]);
        if (!updated.rowCount) throw new Error("Knowledge release is not an editable draft");
        await client.query("DELETE FROM knowledge_documents WHERE release_id = $1", [releaseId]);
        await insertDocuments(client, releaseId, documents);
        return { releaseId, status: "draft", policy: value.policy, documents };
      });
    },
    async deleteDraft(releaseId, adminId) {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      const result = await getQueryExecutor(pool).query("DELETE FROM knowledge_releases WHERE id = $1 AND admin_id = $2 AND status = 'draft' RETURNING id", [releaseId, adminId]);
      if (!result.rowCount) throw new Error("Knowledge release is not an editable draft");
    },
    async beginPreparation(releaseId, adminId) {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      return transaction(pool, async client => {
        const result = await client.query("UPDATE knowledge_releases SET status = 'preparing', updated_at = now() WHERE id = $1 AND admin_id = $2 AND status = 'draft' RETURNING id", [releaseId, adminId]);
        if (!result.rowCount) throw new Error("Knowledge release is not a draft");
        const release = await readRelease(client, releaseId, adminId);
        const conflict = await client.query("SELECT version FROM agency_policy_versions WHERE version=$1 AND policy <> $2::jsonb", [release.policy.version, JSON.stringify(release.policy)]);
        if (conflict.rowCount) throw Object.assign(new Error("Policy revision already describes different contents"), { code: "POLICY_VERSION_CONFLICT" });
        return release;
      });
    },
    async commitPreparedRelease(releaseId, prepared, adminId) {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      await transaction(pool, async client => {
        const locked = await client.query("SELECT id FROM knowledge_releases WHERE id = $1 AND admin_id = $2 AND status = 'preparing' AND model_id = $3 AND model_revision = $4 AND dimensions = $5 FOR UPDATE", [releaseId, adminId, E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS]);
        if (!locked.rowCount) throw new Error("Knowledge release is not preparing with the pinned E5 model");
        const release = await readRelease(client, releaseId, adminId);
        agencyPolicySchema.parse(release.policy);
        const serializedPolicy = JSON.stringify(release.policy);
        await client.query("INSERT INTO agency_policy_versions(version,policy) VALUES($1,$2::jsonb) ON CONFLICT(version) DO NOTHING", [release.policy.version, serializedPolicy]);
        // A fresh READ COMMITTED statement observes a competing version claimant after it commits.
        const revision = await client.query("SELECT version FROM agency_policy_versions WHERE version=$1 AND policy=$2::jsonb", [release.policy.version, serializedPolicy]);
        if (!revision.rowCount) throw Object.assign(new Error("Policy revision already describes different contents"), { code: "POLICY_VERSION_CONFLICT" });
        if (prepared.length !== release.documents.length || new Set(prepared.map(document => document.documentId)).size !== prepared.length) throw new Error("Prepared documents do not match the release");
        for (const document of release.documents) {
          const preparedDocument = prepared.find(value => value.documentId === document.documentId);
          if (!preparedDocument?.chunks.length) throw new Error("Every document requires prepared chunks");
          for (const [ordinal, chunk] of preparedDocument.chunks.entries()) {
            if (chunk.documentId !== document.documentId || chunk.title !== document.title || chunk.ordinal !== ordinal || !chunk.text || !Number.isInteger(chunk.tokenCount) || chunk.tokenCount < 1 || chunk.tokenCount > 512 || chunk.embedding.length !== E5_DIMENSIONS || !chunk.embedding.every(Number.isFinite) || Math.abs(Math.hypot(...chunk.embedding) - 1) > 0.001) throw new Error("Invalid prepared knowledge chunk/vector");
            await client.query("INSERT INTO knowledge_chunks (document_id,release_id,visibility,ordinal,text,token_count,embedding) VALUES ($1,$2,$3,$4,$5,$6,$7::vector)",
              [document.documentId, releaseId, document.visibility, ordinal, chunk.text, chunk.tokenCount, JSON.stringify(chunk.embedding)]);
          }
        }
        await client.query("UPDATE knowledge_releases SET status = 'ready', failure_code = NULL, published_at = now(), updated_at = now() WHERE id = $1", [releaseId]);
        await client.query("INSERT INTO knowledge_active_release (singleton,release_id) VALUES (true,$1) ON CONFLICT (singleton) DO UPDATE SET release_id = EXCLUDED.release_id, activated_at = now()", [releaseId]);
      });
    },
    async failPreparation(releaseId, adminId, failureCode = "KNOWLEDGE_PREPARATION_FAILED") {
      idSchema.parse(releaseId); adminSchema.parse(adminId);
      // Never demote a committed release after an ambiguous COMMIT acknowledgement.
      await getQueryExecutor(pool).query("UPDATE knowledge_releases SET status = 'failed', failure_code = $3, updated_at = now() WHERE id = $1 AND admin_id = $2 AND status IN ('draft', 'preparing')", [releaseId, adminId, failureCode]);
      const result = await getQueryExecutor(pool).query<{ status: KnowledgeRelease["status"] }>("SELECT status FROM knowledge_releases WHERE id = $1 AND admin_id = $2", [releaseId, adminId]);
      const status = result.rows[0]?.status;
      if (status !== "failed" && status !== "ready") throw new Error("Cannot persist publication failure state");
      return status;
    },
    async getActiveRelease() {
      const result = await getQueryExecutor(pool).query<{ id: string; policy: AgencyPolicy }>(
        "SELECT r.id,r.policy FROM knowledge_active_release a JOIN knowledge_releases r ON r.id = a.release_id WHERE a.singleton = true AND r.status = 'ready' AND r.model_id = $1 AND r.model_revision = $2 AND r.dimensions = $3", [E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS]);
      if (!result.rowCount) throw new KnowledgeNotReadyError();
      return { releaseId: result.rows[0].id, policy: agencyPolicySchema.parse(result.rows[0].policy) };
    },
  };
}
export async function getActiveRelease(): Promise<ActiveRelease> {
  return createReleaseRepository(getPool()).getActiveRelease();
}
