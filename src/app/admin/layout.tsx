import Image from "next/image";
import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { readAdminSession } from "@/server/auth/session";
import AdminShell from "@/components/admin/AdminShell";
import { Notice } from "@/components/ui/Notice";
import "./admin.css";
export const dynamic = "force-dynamic";
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const incoming = await headers();
  const { identity } = await readAdminSession(new Request("http://localhost/admin", { headers: { cookie: incoming.get("cookie") ?? "" } }));
  if (identity.status === "signed_out") redirect("/login");
  if (identity.status === "denied") redirect("/login?reason=denied");
  if (identity.status !== "authenticated") return (
    <main className="auth" id="main-content">
      <div className="auth-card">
        <Image src="/brand/leaddesk-horizontal.svg" width={192} height={49} alt="LeadDesk" unoptimized />
        <h1 className="auth-title">Administration is unavailable</h1>
        <Notice title="Authentication is not connected or could not be verified" tone="warn">
          No private information is shown. Try signing in when the connection is available.
        </Notice>
        <Link className="btn btn-primary" href="/login">Go to sign in</Link>
        <Link href="/">Go to consultation</Link>
      </div>
    </main>
  );
  return <AdminShell email={identity.email}>{children}</AdminShell>;
}
