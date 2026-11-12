"use client";
import { useRef, useState, type FormEvent } from "react";
import Image from "next/image";
import Link from "next/link";
import { ApiError, requestJson } from "@/client/api";
import { Notice } from "@/components/ui/Notice";
import { Icon } from "@/components/ui/Icon";
export default function LoginForm({ returnTo, configured, denied = false }: { returnTo: string; configured: boolean; denied?: boolean }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [busy, setBusy] = useState(false); const lock = useRef(false); const [error, setError] = useState(denied ? "This account does not have administrator access. Ask the agency owner to grant access." : "");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); if (lock.current) return; lock.current = true; setBusy(true); setError("");
    try { const result = await requestJson<{ returnTo: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password, returnTo }) }); setPassword(""); window.location.replace(result.returnTo); }
    catch (error) { setPassword(""); setError(error instanceof ApiError && error.code === "ADMIN_ACCESS_DENIED" ? "This account does not have administrator access. Ask the agency owner to grant access." : error instanceof ApiError && error.code === "AUTH_SIGN_IN_FAILED" ? "We couldn’t sign you in. Check your email and password and try again." : error instanceof ApiError && error.code === "AUTH_RATE_LIMITED" ? "Too many sign-in attempts. Wait before trying again." : "Administrator sign-in is unavailable or not connected. Please try again later."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <div className="auth"><main className="auth-card" id="main-content">
    <Image src="/brand/leaddesk-horizontal.svg" width={192} height={49} alt="LeadDesk" />
    <div><h1 className="auth-title">Sign in to administration</h1><p className="auth-sub">For the agency’s authorized administrator.</p></div>
    {!configured && <Notice title="Sign-in is not connected" tone="warn">Administrator authentication is unavailable until the agency configures its connection. No private content is shown.</Notice>}
    {error && <Notice title="Unable to sign in" tone="danger">{error}</Notice>}
    <form className="form" onSubmit={submit}>
      <div className="field"><label className="field-label" htmlFor="login-email">Email</label><input className="input" id="login-email" type="email" autoComplete="username" inputMode="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} disabled={!configured || busy} /></div>
      <div className="field"><label className="field-label" htmlFor="login-password">Password</label><input className="input" id="login-password" type="password" autoComplete="current-password" required maxLength={1024} value={password} onChange={event => setPassword(event.target.value)} disabled={!configured || busy} /></div>
      <button className="btn btn-primary btn-block" disabled={!configured || busy}>{busy && <Icon name="loader" className="spin" />}{busy ? "Signing in…" : "Sign in"}</button>
    </form>
    <p className="auth-foot">There’s no public sign-up. Administrator access is granted by the agency. <Link href="/">Go to consultation</Link></p>
  </main></div>;
}
