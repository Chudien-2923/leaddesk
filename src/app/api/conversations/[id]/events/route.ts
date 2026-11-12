import { createConfiguredConversationService } from "@/server/conversation/service";
import { conversationEventSchema } from "@/server/conversation/state";
import { publicChatView } from "@/server/conversation/public-view";
import { consumeRateLimit, handleHttp, parseInput, readMutationJson, requirePathOwner, safeJson } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHttp(async () => {
    const event = parseInput(conversationEventSchema, await readMutationJson(request));
    const owner = await requirePathOwner(request, (await context.params).id);
    if (event.type === "message") await consumeRateLimit("message", owner.conversationId.toLowerCase());
    const service = await createConfiguredConversationService(owner);
    return safeJson(publicChatView(await service.handleEvent(event, request.signal)));
  });
}
