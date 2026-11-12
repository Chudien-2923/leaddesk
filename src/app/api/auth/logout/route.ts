import { z } from "zod";
import { createAdminSession } from "@/server/auth/session";
import { handleHttp, HttpError, parseInput, readMutationJson, safeJson } from "@/server/http/guards";
export const runtime = "nodejs";
export async function POST(request: Request): Promise<Response> {
  return handleHttp(async () => {
    parseInput(z.object({}).strict(), await readMutationJson(request));
    let session: ReturnType<typeof createAdminSession>;
    try { session = createAdminSession(request); } catch { throw new HttpError("AUTH_UNAVAILABLE", 503); }
    try { await session.client.auth.signOut({ scope: "local" }); } catch { /* Local cookies are removed even if Auth is unreachable. */ }
    session.clearCookies();
    return safeJson({ signedOut: true }, { headers: session.headers });
  });
}
