import { readAdminSession } from "@/server/auth/session";
import { safeJson } from "@/server/http/guards";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  const { identity, headers } = await readAdminSession(request);
  return safeJson(identity, { status: identity.status === "unavailable" ? 503 : identity.status === "authenticated" ? 200 : identity.status === "denied" ? 403 : 401, headers });
}
