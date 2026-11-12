import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { Annotation, END, START, StateGraph, type CompiledStateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import type { Pool } from "pg";
import type { ConversationDependencies } from "./service";
import type { ChatView, ConversationEvent } from "./state";

const CHECKPOINT_SCHEMA = "leaddesk_checkpoints";
const stores = new WeakMap<Pool, { saver: PostgresSaver; ready?: Promise<void> }>();

function checkpointStore(pool: Pool) {
  let store = stores.get(pool);
  if (!store) {
    store = { saver: new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA }) };
    stores.set(pool, store);
  }
  return store;
}

/** The owner lock holds one connection while PostgresSaver uses another. */
export function assertConversationPool(pool: Pool): void {
  if ((pool.options.max ?? 10) < 2) {
    throw Object.assign(new Error("Conversation graphs require a pool with at least two connections"), { code: "CONVERSATION_POOL_CONFIGURATION" });
  }
}

export function prepareConversationGraph(pool: Pool): Promise<void> {
  assertConversationPool(pool);
  const store = checkpointStore(pool);
  return store.ready ??= (async () => {
    await store.saver.setup();
    await pool.query(`
      REVOKE ALL ON SCHEMA leaddesk_checkpoints FROM PUBLIC;
      REVOKE ALL ON ALL TABLES IN SCHEMA leaddesk_checkpoints FROM PUBLIC;
      REVOKE ALL ON ALL SEQUENCES IN SCHEMA leaddesk_checkpoints FROM PUBLIC;
      ALTER DEFAULT PRIVILEGES IN SCHEMA leaddesk_checkpoints REVOKE ALL ON TABLES FROM PUBLIC;
      DO $$ DECLARE role_name text; BEGIN
        FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            EXECUTE format('REVOKE ALL ON SCHEMA leaddesk_checkpoints FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA leaddesk_checkpoints FROM %I', role_name);
            EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA leaddesk_checkpoints FROM %I', role_name);
            EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA leaddesk_checkpoints REVOKE ALL ON TABLES FROM %I', role_name);
          END IF;
        END LOOP;
      END $$;
    `);
  })();
}

/** Event capabilities live only in this invocation, never in checkpoint state/config. */
export interface ConversationTurn {
  id: string;
  event: ConversationEvent;
  load(): Promise<ChatView>;
  extract(): Promise<ChatView>;
  answer(): Promise<ChatView>;
  qualify(): Promise<ChatView>;
  consentGate(): Promise<ChatView>;
  submitContact(): Promise<ChatView>;
  listSlots(): Promise<ChatView>;
  selectSlot(): Promise<ChatView>;
  confirmGate(): Promise<ChatView>;
  confirmBooking(): Promise<ChatView>;
  handoff(): Promise<ChatView>;
}
const turns = new AsyncLocalStorage<ConversationTurn>();
const graphState = Annotation.Root({
  turnId: Annotation<string>(),
  view: Annotation<ChatView | null>(),
});
function currentTurn(state: typeof graphState.State): ConversationTurn {
  const turn = turns.getStore();
  // A pending checkpoint task is not an authorization to replay an earlier event.
  if (!turn || turn.id !== state.turnId) throw new Error("Conversation invocation is no longer active");
  return turn;
}

export function buildConversationGraph(deps: ConversationDependencies): CompiledConversationGraph {
  assertConversationPool(deps.pool);
  const node = (method: Exclude<keyof ConversationTurn, "id" | "event">) => async (state: typeof graphState.State) => ({
    view: await currentTurn(state)[method](),
  });
  const failed = (state: typeof graphState.State) => state.view?.safeError ? "stop" : "continue";
  return new StateGraph(graphState)
    .addNode("load_canonical", node("load"))
    .addNode("extraction", node("extract"))
    .addNode("retrieval_answer", node("answer"))
    .addNode("qualification", node("qualify"))
    .addNode("consent_gate", node("consentGate"))
    .addNode("crm", node("submitContact"))
    .addNode("slots", node("listSlots"))
    .addNode("slot_selection", node("selectSlot"))
    .addNode("confirm_gate", node("confirmGate"))
    .addNode("booking", node("confirmBooking"))
    .addNode("handoff", node("handoff"))
    .addEdge(START, "load_canonical")
    .addConditionalEdges("load_canonical", state => currentTurn(state).event.type, {
      message: "extraction", submit_contact: "consent_gate", select_slot: "slot_selection",
      confirm_slot: "confirm_gate", request_handoff: "handoff",
    })
    .addConditionalEdges("extraction", failed, { stop: "qualification", continue: "retrieval_answer" })
    .addEdge("retrieval_answer", "qualification")
    .addEdge("qualification", END)
    .addConditionalEdges("consent_gate", failed, { stop: END, continue: "crm" })
    .addConditionalEdges("crm", failed, { stop: END, continue: "slots" })
    .addEdge("slots", END)
    .addEdge("slot_selection", END)
    .addConditionalEdges("confirm_gate", failed, { stop: END, continue: "booking" })
    .addEdge("booking", END)
    .addEdge("handoff", END)
    .compile({ checkpointer: checkpointStore(deps.pool).saver });
}
export type CompiledConversationGraph = CompiledStateGraph<
  typeof graphState.State, typeof graphState.Update,
  "__start__" | "load_canonical" | "extraction" | "retrieval_answer" | "qualification" | "consent_gate" | "crm" | "slots" | "slot_selection" | "confirm_gate" | "booking" | "handoff",
  typeof graphState.spec, typeof graphState.spec
>;

export async function runConversationGraph(graph: CompiledConversationGraph, conversationId: string, turn: ConversationTurn, signal: AbortSignal): Promise<void> {
  await turns.run(turn, () => graph.invoke({ turnId: turn.id, view: null }, {
    configurable: { thread_id: conversationId }, signal, durability: "sync",
  }));
}
