import { z } from "zod";
import { createVisitorCookie, requireVisitor } from "@/server/auth/visitor";
import { createConfiguredConversationService } from "@/server/conversation/service";
import { publicChatView } from "@/server/conversation/public-view";
import { createConversation } from "@/server/db/conversations";
import { handleHttp, limitConversationCreation, parseInput, readMutationJson, safeJson } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const createSchema = z.object({ acceptedDemoNotice: z.literal(true) }).strict();

export async function POST(request: Request): Promise<Response> {
  return handleHttp(async () => {
    parseInput(createSchema, await readMutationJson(request));
    await limitConversationCreation(request);
    const created = await createConversation();
    const owner = { conversationId: created.id, token: created.token };
    const service = await createConfiguredConversationService(owner);
    return safeJson(publicChatView(await service.getView()), { status: 201, headers: { "Set-Cookie": createVisitorCookie(created, request) } });
  });
}
export async function GET(request: Request): Promise<Response> {
  return handleHttp(async () => {
    const service = await createConfiguredConversationService(await requireVisitor(request));
    return safeJson(publicChatView(await service.getView()));
  });
}
