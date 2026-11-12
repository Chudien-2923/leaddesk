import "server-only";
import { createServerClient, parseCookieHeader, serializeCookieHeader } from "@supabase/ssr";
import { getAdminAuthConfig } from "../config";

export interface AdminIdentity {
  userId: string;
  // Route handlers must forward these headers, including refreshed SSR cookies.
  headers: Headers;
}

export async function requireAdmin(request: Request): Promise<AdminIdentity> {
  const config = getAdminAuthConfig();
  const headers = new Headers({ "Cache-Control": "private, no-store" });
  const requestCookies = parseCookieHeader(request.headers.get("cookie") ?? "");
  const client = createServerClient(config.NEXT_PUBLIC_SUPABASE_URL, config.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookieOptions: { httpOnly: true, sameSite: "lax", path: "/", secure: new URL(request.url).protocol === "https:" },
    cookies: {
      getAll: () => requestCookies,
      setAll: (cookies, cacheHeaders) => {
        for (const { name, value, options } of cookies) {
          headers.append("Set-Cookie", serializeCookieHeader(name, value, options));
          const existing = requestCookies.find((cookie) => cookie.name === name);
          if (existing) existing.value = value;
          else requestCookies.push({ name, value });
        }
        for (const [name, value] of Object.entries(cacheHeaders)) headers.set(name, value);
      },
    },
  });
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer (\S+)$/i)?.[1];
  if (authorization && !bearer) {
    throw Object.assign(new Error("Administrator authentication required"), { code: "ADMIN_UNAUTHORIZED" });
  }
  // getUser verifies with Supabase Auth. Client claims, getSession and decoded JWT roles are not authorization.
  const { data, error } = bearer ? await client.auth.getUser(bearer) : await client.auth.getUser();
  if (error || !data.user || data.user.id !== config.ADMIN_USER_ID) {
    throw Object.assign(new Error("Administrator access denied"), { code: "ADMIN_UNAUTHORIZED" });
  }
  return { userId: data.user.id, headers };
}
