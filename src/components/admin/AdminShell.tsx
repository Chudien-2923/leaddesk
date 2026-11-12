"use client";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { requestJson } from "@/client/api";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { adminError } from "./Common";
export default function AdminShell({ email, children }: { email: string; children: ReactNode }) {
  const path = usePathname(); const busyRef = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void requestJson("/api/auth/session").catch(error => {
      if (active) setError(adminError(error));
    });
    return () => { active = false; };
  }, []);
  async function logout() { if (busyRef.current) return; busyRef.current = true; setBusy(true); setError(""); try { await requestJson("/api/auth/logout", { method: "POST", body: "{}" }); window.location.replace("/login"); } catch (error) { setError(adminError(error)); busyRef.current = false; setBusy(false); } }
  return <div className="adm">
    <header className="adm-side">
      <Link className="brand" href="/admin/knowledge" aria-label="LeadDesk administration"><Image src="/brand/leaddesk-horizontal.svg" width={192} height={49} alt="LeadDesk" /></Link>
      <p className="adm-brand-sub">Administration</p>
      <nav className="adm-nav" aria-label="Administration">{[["knowledge", "book", "Knowledge"], ["handoffs", "inbox", "Requests"], ["operations", "activity", "Integrations"]].map(([route, icon, label]) => <Link key={route} href={"/admin/" + route} className="adm-nav-link" aria-current={path === "/admin/" + route ? "page" : undefined}><Icon name={icon} />{label}</Link>)}</nav>
      <div className="adm-account"><p className="adm-account-label">Signed in as</p><p className="adm-account-email od-truncate">{email || "Authorized administrator"}</p><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => void logout()}><Icon name="logOut" />{busy ? "Signing out…" : "Sign out"}</button></div>
    </header>
    <main className="adm-main" id="main-content" tabIndex={-1}>{error && <Notice title="Administrator session issue" tone="danger">{error}</Notice>}{children}</main>
  </div>;
}
