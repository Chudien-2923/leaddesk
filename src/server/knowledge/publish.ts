import "server-only";
import type { Pool } from "pg";
import { agencyPolicySchema, renderPricingPolicy } from "../../domain/policy";
import { createReleaseRepository, type KnowledgeInput, type PreparedDocument, type PublicationFailureCode } from "../db/releases";
import { getPool } from "../db/pool";
import { chunkDocument, type E5Tokenizer } from "./chunking";
import { embed as localEmbed, getE5Tokenizer, type Embed } from "./embedding";

export interface PublishResult { releaseId: string; status: "ready" | "failed"; safeCode?: PublicationFailureCode }
export interface PublisherDependencies { pool: Pool; embed?: Embed; tokenizer?: E5Tokenizer }
export type PublishKnowledge = (input: KnowledgeInput, adminId: string) => Promise<PublishResult>;

export function createKnowledgePublisher(dependencies: PublisherDependencies): PublishKnowledge {
  const repository = createReleaseRepository(dependencies.pool);
  const embed = dependencies.embed ?? localEmbed;
  return async (input, adminId) => {
    // Invalid input is rejected before any release exists; preparation failures remain auditable.
    agencyPolicySchema.parse(input.policy);
    const draft = await repository.createDraft(input, adminId);
    try {
      const pricing = draft.documents.find(document => document.kind === "pricing" && document.visibility === "public");
      const documents = draft.documents.filter(document => document.kind !== "pricing" || document.visibility !== "public");
      documents.push({
        ...(pricing ?? { documentId: crypto.randomUUID(), title: "Pricing and consultation requirements", kind: "pricing" as const, visibility: "public" as const }),
        body: renderPricingPolicy(input.policy),
      });
      await repository.updateDraft(draft.releaseId, { documents, policy: input.policy }, adminId);
      const release = await repository.beginPreparation(draft.releaseId, adminId);
      const tokenizer = dependencies.tokenizer ?? await getE5Tokenizer();
      const prepared: PreparedDocument[] = [];
      for (const document of release.documents) {
        const chunks = await chunkDocument(document, tokenizer);
        const vectors = await embed(chunks.map(chunk => chunk.text), "passage");
        if (vectors.length !== chunks.length) throw new Error("Embedding batch does not match prepared chunks");
        prepared.push({ documentId: document.documentId, chunks: chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] })) });
      }
      await repository.commitPreparedRelease(release.releaseId, prepared, adminId);
      return { releaseId: release.releaseId, status: "ready" };
    } catch (cause) {
      const failureCode: PublicationFailureCode = cause && typeof cause === "object" && "code" in cause && cause.code === "POLICY_VERSION_CONFLICT"
        ? "POLICY_VERSION_CONFLICT" : "KNOWLEDGE_PREPARATION_FAILED";
      // The repository guards a release that already committed against false failure/demotion.
      const status = await repository.failPreparation(draft.releaseId, adminId, failureCode);
      return { releaseId: draft.releaseId, status, ...(status === "failed" ? { safeCode: failureCode } : {}) };
    }
  };
}
export async function publishKnowledge(input: KnowledgeInput, adminId: string): Promise<PublishResult> {
  return createKnowledgePublisher({ pool: getPool() })(input, adminId);
}
