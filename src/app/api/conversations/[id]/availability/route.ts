import { createConfiguredConversationService } from "@/server/conversation/service";
import { publicChatView } from "@/server/conversation/public-view";
import { handleHttp, requirePathOwner, safeJson } from "@/server/http/guards";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  return handleHttp(async () => {
    const owner = await requirePathOwner(request, (await context.params).id);
    return safeJson(publicChatView(await (await createConfiguredConversationService(owner)).getAvailability()));
  });
}
