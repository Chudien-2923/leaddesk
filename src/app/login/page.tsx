import LoginForm from "@/components/admin/LoginForm";
import { adminReturnTo } from "@/server/auth/session";
import { getAdminAuthConfig } from "@/server/config";
export const dynamic = "force-dynamic";
export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams; let configured = true;
  try { getAdminAuthConfig(); } catch { configured = false; }
  return <LoginForm returnTo={adminReturnTo(query.returnTo)} configured={configured} denied={query.reason === "denied"} />;
}
