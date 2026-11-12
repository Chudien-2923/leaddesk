import { z } from "zod";
import { createAdminSession, adminReturnTo } from "@/server/auth/session";
import { handleHttp, HttpError, parseInput, readMutationJson, safeJson } from "@/server/http/guards";
export const runtime = "nodejs";
const inputSchema = z.object({ email: z.string().trim().max(254).pipe(z.email()), password: z.string().min(1).max(1024), returnTo: z.string().optional() }).strict();
export async function POST(request: Request): Promise<Response> {
  return handleHttp(async () => {
    const input = parseInput(inputSchema, await readMutationJson(request, 8192));
    let session: ReturnType<typeof createAdminSession>;
    try { session = createAdminSession(request); } catch { throw new HttpError("AUTH_UNAVAILABLE", 503); }
    try {
      const signedIn = await session.client.auth.signInWithPassword({ email: input.email, password: input.password });
      if (signedIn.error) {
        session.clearCookies();
        const status = signedIn.error.status === 429 ? 429 : !signedIn.error.status || signedIn.error.status >= 500 ? 503 : 401;
        return safeJson({ error: { code: status === 429 ? "AUTH_RATE_LIMITED" : status === 503 ? "AUTH_UNAVAILABLE" : "AUTH_SIGN_IN_FAILED" } }, { status, headers: session.headers });
      }
      const verified = await session.client.auth.getUser();
      if (verified.error || !verified.data.user) {
        session.clearCookies();
        return safeJson({ error: { code: "AUTH_UNAVAILABLE" } }, { status: 503, headers: session.headers });
      }
      if (verified.data.user.id !== session.config.ADMIN_USER_ID) {
        await session.client.auth.signOut({ scope: "local" }).catch(() => undefined);
        session.clearCookies();
        return safeJson({ error: { code: "ADMIN_ACCESS_DENIED" } }, { status: 403, headers: session.headers });
      }
      return safeJson({ returnTo: adminReturnTo(input.returnTo) }, { headers: session.headers });
    } catch { session.clearCookies(); return safeJson({ error: { code: "AUTH_UNAVAILABLE" } }, { status: 503, headers: session.headers }); }
  });
}
