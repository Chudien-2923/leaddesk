import "server-only";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { getAdminAuthConfig } from "../config";

export type SessionIdentity = { status: "authenticated"; userId: string; email: string } | { status: "signed_out" | "denied" | "unavailable" };
export function createAdminSession(request: Request) {
  const config = getAdminAuthConfig();
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  const cookies = parseCookieHeader(request.headers.get("cookie") ?? "");
  const secure = new URL(request.url).protocol === "https:";
  const client = createServerClient(config.NEXT_PUBLIC_SUPABASE_URL, config.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { httpOnly: true, sameSite: "lax", path: "/", secure },
    cookies: {
      getAll: () => cookies,
      setAll: (values, cacheHeaders) => {
        for (const { name, value, options } of values) {
          headers.append("Set-Cookie", serializeCookieHeader(name, value, { ...options, httpOnly: true, sameSite: "lax", path: "/", secure }));
          const existing = cookies.find(cookie => cookie.name === name);
          if (existing) existing.value = value; else cookies.push({ name, value });
        }
        for (const [name, value] of Object.entries(cacheHeaders)) headers.set(name, value);
      },
    },
  });
  const clearCookies = () => {
    const key = "sb-" + new URL(config.NEXT_PUBLIC_SUPABASE_URL).hostname.split(".")[0] + "-auth-token";
    for (const cookie of cookies) if (cookie.name === key || cookie.name.startsWith(key + ".")) {
      headers.append("Set-Cookie", serializeCookieHeader(cookie.name, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 }));
    }
  };
  return { client, config, headers, clearCookies };
}
export async function readAdminSession(request: Request): Promise<{ identity: SessionIdentity; headers: Headers }> {
  let session: ReturnType<typeof createAdminSession>;
  try { session = createAdminSession(request); }
  catch { return { identity: { status: "unavailable" }, headers: new Headers() }; }
  try {
    const { data, error } = await session.client.auth.getUser();
    if (error || !data.user) {
      const unavailable = error && (error.status === undefined || error.status >= 500 || error.status === 429);
      return { identity: { status: unavailable ? "unavailable" : "signed_out" }, headers: session.headers };
    }
    if (data.user.id !== session.config.ADMIN_USER_ID) return { identity: { status: "denied" }, headers: session.headers };
    return { identity: { status: "authenticated", userId: data.user.id, email: data.user.email ?? "" }, headers: session.headers };
  } catch { return { identity: { status: "unavailable" }, headers: session.headers }; }
}
export function adminReturnTo(value: unknown): string {
  return typeof value === "string" && ["/admin", "/admin/knowledge", "/admin/handoffs", "/admin/operations"].includes(value) ? value : "/admin/knowledge";
}
