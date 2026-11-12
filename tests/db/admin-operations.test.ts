import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import type { AdminIdentity } from "../../src/server/auth/admin";
import { createConversationRepository } from "../../src/server/db/conversations";
import { createLeadService } from "../../src/server/leads/crm";
import { startTestDatabase, type TestDatabase } from "./setup";

const boundary = vi.hoisted(() => ({ pool: undefined as Pool | undefined }));
vi.mock("../../src/server/db/pool", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/server/db/pool")>(),
  getPool: () => boundary.pool!,
}));
// Identity validation is an external Supabase boundary; SQL, CRM state and the HTTP response stay real.
vi.mock("../../src/server/http/guards", async importOriginal => ({
  ...await importOriginal<typeof import("../../src/server/http/guards")>(),
  handleAdmin: async (_request: Request, action: (admin: AdminIdentity) => Promise<Response>) =>
    action({ headers: new Headers() } as AdminIdentity),
}));
import { GET } from "../../src/app/api/admin/operations/route";

let db: TestDatabase;
beforeAll(async () => { db = await startTestDatabase(); boundary.pool = db.pool; }, 120_000);
afterAll(async () => { await db?.stop(); }, 30_000);

// Losing the joined lead progress would mislabel a saved Contact / missing Note as a wholly failed write.
it.each([
  { failure: "contact", status: "failed", contactSaved: false },
  { failure: "note", status: "partial", contactSaved: true },
  { failure: "unknown-note", status: "unknown", contactSaved: true },
])("reports $status and committed CRM stages after $failure failure", async ({ failure, status, contactSaved }) => {
  const repository = createConversationRepository(db.pool);
  const created = await repository.createConversation();
  const owner = { conversationId: created.id, token: created.token };
  await repository.saveConversation({ ...owner, state: {}, facts: {
    service: "meta_ads", business: "Synthetic shop", hasWebsite: false,
    budget: { kind: "total", totalMonthlyVnd: 15_000_000 }, startDate: "2026-11-19",
  }, factsVersion: 1, policyVersion: DEFAULT_POLICY.version });
  const rejected = () => Object.assign(new Error("Controlled provider rejection"), {
    outcome: failure === "unknown-note" ? "unknown" : "failed", code: "permission",
  });
  const crm = createLeadService({ pool: db.pool, owner,
    now: () => new Date("2026-11-12T02:00:00Z"),
    getActiveRelease: async () => ({ releaseId: "synthetic-release", policy: DEFAULT_POLICY }),
    hubspot: {
      findContactByEmail: async () => null,
      createContact: async () => { if (failure === "contact") throw rejected(); return { id: "private-contact-id" }; },
      createNote: async () => { throw rejected(); },
      findNoteByMarker: async () => null,
      updateNote: async () => { throw new Error("Unexpected update"); },
    },
  });
  await crm.submitLead({ contact: { name: "Synthetic visitor", email: "admin-progress@example.com" }, consent: true, factsVersion: 1 }, "submit");
  const response = await GET(new Request("http://127.0.0.1/api/admin/operations"));
  const body = await response.json();
  const operation = body.operations.find((row: { conversationId: string }) => row.conversationId === created.id);
  expect(operation).toMatchObject({ kind: "crm", status, crmProgress: { contactSaved, noteSaved: false } });
  expect(JSON.stringify(operation)).not.toContain("private-contact-id");
  expect(JSON.stringify(operation)).not.toContain("admin-progress@example.com");
  const journal = await db.pool.query("SELECT status FROM integration_operations WHERE id=$1", [operation.id]);
  expect(journal.rows[0].status).toBe(status === "unknown" ? "unknown" : "failed");
});
