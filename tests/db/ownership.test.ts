import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createConversationRepository,
  type ConversationRepository,
} from "../../src/server/db/conversations";
import { startTestDatabase, type TestDatabase } from "./setup";

const privateTables = [
  "conversations",
  "consents",
  "integration_operations",
  "handoff_requests",
  "model_runs",
] as const;

const stateA = {
  messages: [{ role: "user", content: "Synthetic private conversation A" }],
  factsVersion: 1,
};
const stateB = {
  messages: [{ role: "user", content: "Synthetic private conversation B" }],
  factsVersion: 2,
};

describe("conversation ownership on isolated PostgreSQL", () => {
  let database: TestDatabase | undefined;
  let conversations: ConversationRepository;

  beforeAll(async () => {
    database = await startTestDatabase();
    conversations = createConversationRepository(database.pool);
  }, 120_000);

  afterAll(async () => {
    await database?.stop();
  }, 30_000);

  it("persists an owner's thread without persisting the bearer token in cleartext", async () => {
    const owner = await conversations.createConversation();
    const access = { conversationId: owner.id, token: owner.token };
    await conversations.saveConversation({ ...access, state: stateA });

    // A fresh repository must read durable state, not a process-local map.
    const reopened = createConversationRepository(database!.createPool(1));
    expect(await reopened.getConversation(access)).toMatchObject({ id: owner.id, state: stateA });
    const stored = await database!.pool.query<{ row: Record<string, unknown> }>(
      "SELECT to_jsonb(c) AS row FROM conversations c WHERE id = $1",
      [owner.id],
    );
    expect(stored.rows).toHaveLength(1);
    expect(JSON.stringify(stored.rows[0].row)).not.toContain(owner.token);
    expect(stored.rows[0].row.token_hash).toEqual(expect.any(String));
    expect(String(stored.rows[0].row.token_hash).length).toBeGreaterThanOrEqual(32);
  });

  it("rejects both cross-token reads and writes while preserving both owners' state", async () => {
    const [a, b] = await Promise.all([
      conversations.createConversation(),
      conversations.createConversation(),
    ]);
    expect(a.token).not.toBe(b.token);
    await conversations.saveConversation({ conversationId: a.id, token: a.token, state: stateA });
    await conversations.saveConversation({ conversationId: b.id, token: b.token, state: stateB });

    await expect(conversations.getConversation({ conversationId: a.id, token: b.token })).rejects.toThrow();
    await expect(conversations.getConversation({ conversationId: b.id, token: a.token })).rejects.toThrow();
    await expect(conversations.saveConversation({ conversationId: a.id, token: b.token, state: stateB })).rejects.toThrow();
    await expect(conversations.saveConversation({ conversationId: b.id, token: a.token, state: stateA })).rejects.toThrow();

    expect(await conversations.getConversation({ conversationId: a.id, token: a.token })).toMatchObject({ state: stateA });
    expect(await conversations.getConversation({ conversationId: b.id, token: b.token })).toMatchObject({ state: stateB });
  });

  it("does not treat knowledge of a conversation ID as authorization", async () => {
    const owner = await conversations.createConversation();
    await conversations.saveConversation({ conversationId: owner.id, token: owner.token, state: stateA });
    await expect(conversations.getConversation({ conversationId: owner.id, token: "" })).rejects.toThrow();
    await expect(conversations.saveConversation({ conversationId: owner.id, token: "invalid-bearer", state: stateB })).rejects.toThrow();
    expect(await conversations.getConversation({ conversationId: owner.id, token: owner.token })).toMatchObject({ state: stateA });
  });

  it.each(["anon", "authenticated"] as const)("denies private SELECT to the real PostgreSQL %s role", async (role) => {
    const owner = await conversations.createConversation();
    await conversations.saveConversation({ conversationId: owner.id, token: owner.token, state: stateA });
    const client = await database!.pool.connect();
    try {
      // role is selected only from the two literals above, never from client input.
      await client.query(`SET ROLE ${role}`);
      expect((await client.query<{ current_user: string }>("SELECT current_user")).rows[0].current_user).toBe(role);
      for (const table of privateTables) {
        // 42501 is a real permission failure; a missing table (42P01) cannot pass.
        await expect(client.query(`SELECT * FROM public.${table} LIMIT 1`)).rejects.toMatchObject({ code: "42501" });
      }
    } finally {
      try {
        await client.query("RESET ROLE");
      } finally {
        client.release();
      }
    }
  });
});
