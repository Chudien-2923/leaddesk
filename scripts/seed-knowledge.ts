// Operator-invoked only. No default database, real customer data or remote account lookup.
// Invoke with NODE_OPTIONS=--conditions=react-server for server-only imports.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";
import { agencyPolicySchema, DEFAULT_POLICY } from "../src/domain/policy";
import { createKnowledgePublisher } from "../src/server/knowledge/publish";
import type { KnowledgeDraft } from "../src/server/db/releases";
import { RETRIEVAL_CALIBRATION } from "../src/server/knowledge/retrieve";

let pool: Pool | undefined;
try {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString?.trim()) throw new Error("DATABASE_URL is required");
  const policyPath = process.argv[2];
  if (process.argv.length > 3) throw new Error("Usage: seed:knowledge [policy.json]");
  const policy = agencyPolicySchema.parse(policyPath ? JSON.parse(await readFile(path.resolve(policyPath), "utf8")) : DEFAULT_POLICY);
  // The checked-in qualification JSON must remain a valid structured policy too.
  agencyPolicySchema.parse(JSON.parse(await readFile(path.resolve("data/agency/qualification.json"), "utf8")));
  const sources = [
    { file: "services.md", title: "Advertising management services", kind: "services" },
    { file: "pricing.md", title: "Pricing and consultation requirements", kind: "pricing" },
    { file: "faq.md", title: "Frequently asked questions", kind: "faq" },
    { file: "policies.md", title: "Consultation and service policies", kind: "policies" },
  ] as const;
  const documents: KnowledgeDraft[] = [];
  for (const source of sources) documents.push({ title: source.title, kind: source.kind, visibility: "public", body: await readFile(path.resolve("data/agency", source.file), "utf8") });
  pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000 });
  const result = await createKnowledgePublisher({ pool })({ documents, policy }, process.env.SEED_ADMIN_ID?.trim() || "local-synthetic-seed");
  console.log(JSON.stringify({ releaseId: result.releaseId, status: result.status, dataset: "synthetic-english", calibration: RETRIEVAL_CALIBRATION }));
  if (result.status !== "ready") process.exitCode = 1;
} catch {
  // Never echo connection strings, file contents, provider errors or credentials.
  console.error(JSON.stringify({ status: "failed", code: "KNOWLEDGE_SEED_FAILED" }));
  process.exitCode = 1;
} finally { await pool?.end(); }
