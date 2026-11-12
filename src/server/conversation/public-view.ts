import type { ChatMessage, ChatView } from "./state";

export type PublicChatView = Omit<ChatView, "messages" | "citations"> & {
  messages: Pick<ChatMessage, "id" | "role" | "text">[];
};

/** Grounding and model provenance remain in the checkpoint, never in visitor responses. */
export function publicChatView(view: ChatView): PublicChatView {
  const { citations, messages, ...consultation } = view;
  void citations;
  return {
    ...consultation,
    messages: messages.map(({ id, role, text }) => ({ id, role, text })),
  };
}
