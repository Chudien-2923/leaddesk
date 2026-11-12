import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { createReleaseRepository } from "../../src/server/db/releases";
import { startTestDatabase, type TestDatabase } from "./setup";
let db: TestDatabase;
beforeAll(async () => { db = await startTestDatabase(); }, 120_000);
afterAll(async () => { await db?.stop(); }, 30_000);
const admin = "11111111-1111-4111-8111-111111111111";
function input() { return { documents: [{ documentId: randomUUID(), title: "Recovery policy", body: "Consent is required.", kind: "policies" as const, visibility: "public" as const }], policy: DEFAULT_POLICY }; }
it("replays a lost first-save receipt and concurrent submissions as one owner-bound draft", async () => {
  const repository = createReleaseRepository(db.pool), releaseId = randomUUID(), value = input();
  const [first, replay] = await Promise.all([repository.createDraft(value, admin, releaseId), repository.createDraft(value, admin, releaseId)]);
  expect(first.releaseId).toBe(releaseId);
  expect(replay).toEqual(first);
  expect((await repository.getDraft(releaseId, admin)).documents).toEqual(first.documents);
  expect((await db.pool.query("SELECT id FROM knowledge_releases WHERE id=$1", [releaseId])).rows).toEqual([{ id: releaseId }]);
});
it("rejects changed payloads and a different administrator reusing a draft request ID without overwriting the original", async () => {
  const repository = createReleaseRepository(db.pool), releaseId = randomUUID(), value = input();
  await repository.createDraft(value, admin, releaseId);
  await expect(repository.createDraft({ ...value, documents: [{ ...value.documents[0], body: "Changed consent policy" }] }, admin, releaseId)).rejects.toMatchObject({ code: "DRAFT_REQUEST_CONFLICT" });
  await expect(repository.createDraft(value, "22222222-2222-4222-8222-222222222222", releaseId)).rejects.toMatchObject({ code: "DRAFT_REQUEST_CONFLICT" });
  expect((await repository.getDraft(releaseId, admin)).documents[0].body).toBe("Consent is required.");
});
