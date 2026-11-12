import "server-only";
import type { Pool } from "pg";
import { z } from "zod";
import type { Citation } from "../../domain/types";
import { KnowledgeNotReadyError } from "../db/releases";
import { getPool, getQueryExecutor } from "../db/pool";
import { E5_DIMENSIONS, E5_MODEL_ID, E5_MODEL_REVISION, embed as localEmbed, type Embed } from "./embedding";

export const RETRIEVAL_CALIBRATION = "EN_E5_8Q_2026_11_12" as const;
export const MAX_CONTEXT_ESTIMATED_TOKENS = 3_000;
export interface RetrievalContext {
  citations: Citation[];
  text: string;
  estimatedTokens: number;
  tokenCountKind: "estimated";
  calibration: typeof RETRIEVAL_CALIBRATION;
  minimumSimilarity: number;
}
export interface RetrieverDependencies { pool: Pool; embed?: Embed; threshold?: number }
export type RetrieveContext = (query: string, releaseId: string) => Promise<RetrievalContext>;

export function createContextRetriever(dependencies: RetrieverDependencies): RetrieveContext {
  const embed = dependencies.embed ?? localEmbed;
  // English 8-query smoke uses 0.832 to retain canonical website evidence; margin is narrow. See runbook.
  const threshold = dependencies.threshold ?? Number(process.env.KNOWLEDGE_MIN_SIMILARITY ?? "0.832");
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new Error("Knowledge similarity threshold must be between -1 and 1");
  return async (query, releaseId) => {
    z.string().uuid().parse(releaseId);
    if (!query.trim()) throw new Error("Knowledge query must not be empty");
    const executor = getQueryExecutor(dependencies.pool);
    const ready = await executor.query(
      "SELECT r.id FROM knowledge_active_release a JOIN knowledge_releases r ON r.id = a.release_id WHERE a.singleton = true AND r.id = $1 AND r.status = 'ready' AND r.model_id = $2 AND r.model_revision = $3 AND r.dimensions = $4",
      [releaseId, E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS]);
    if (!ready.rowCount) throw new KnowledgeNotReadyError();
    const vectors = await embed([query], "query");
    const vector = vectors[0];
    if (vectors.length !== 1 || !vector || vector.length !== E5_DIMENSIONS || !vector.every(Number.isFinite) || Math.abs(Math.hypot(...vector) - 1) > 0.001) throw new Error("Invalid query embedding");
    // MATERIALIZED scope prevents ANN/global ranking before release and visibility isolation.
    // Repeat active/ready checks in this statement: publication may switch while embedding runs.
    const result = await executor.query<{ id: string; document_id: string; release_id: string; title: string; text: string; similarity: number }>(
      `WITH eligible AS MATERIALIZED (
        SELECT c.id,c.document_id,c.release_id,d.title,c.text,c.embedding
        FROM knowledge_chunks c JOIN knowledge_documents d ON d.id = c.document_id AND d.release_id = c.release_id
        JOIN knowledge_releases r ON r.id = c.release_id
        JOIN knowledge_active_release a ON a.release_id = r.id AND a.singleton = true
        WHERE r.id = $1 AND r.status = 'ready' AND c.visibility = 'public' AND d.visibility = 'public'
          AND r.model_id = $2 AND r.model_revision = $3 AND r.dimensions = $4
      ) SELECT id,document_id,release_id,title,text,1 - (embedding <=> $5::vector) AS similarity
        FROM eligible WHERE 1 - (embedding <=> $5::vector) >= $6
        ORDER BY embedding <=> $5::vector, id LIMIT 4`,
      [releaseId, E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS, JSON.stringify(vector), threshold]);
    const citations: Citation[] = [];
    const blocks: string[] = [];
    let estimatedTokens = 0;
    for (const row of result.rows) {
      const block = `[source chunk=${row.id} document=${row.document_id} release=${row.release_id}] ${row.title}\n${row.text}`;
      const candidate = [...blocks, block].join("\n\n");
      // Conservative visible character heuristic, not E5 or generation-model token accounting.
      const estimate = Math.ceil(Array.from(candidate).length / 3);
      if (estimate > MAX_CONTEXT_ESTIMATED_TOKENS) continue;
      citations.push({ chunkId: row.id, documentId: row.document_id, releaseId: row.release_id, title: row.title, excerpt: row.text });
      blocks.push(block);
      estimatedTokens = estimate;
    }
    return { citations, text: blocks.join("\n\n"), estimatedTokens, tokenCountKind: "estimated", calibration: RETRIEVAL_CALIBRATION, minimumSimilarity: threshold };
  };
}
export async function retrieveContext(query: string, releaseId: string): Promise<RetrievalContext> {
  return createContextRetriever({ pool: getPool() })(query, releaseId);
}
