"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ApiError, requestJson } from "@/client/api";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
export function adminError(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) { window.location.replace("/login"); return "Your session ended. Sign in to continue."; }
  return error instanceof ApiError ? error.message : "The service is unavailable. No change has been confirmed.";
}
export function Badge({ status }: { status: string }) {
  const tone = ["ready", "succeeded", "resolved"].includes(status) ? "ok" : ["failed"].includes(status) ? "danger" : ["unknown", "partial"].includes(status) ? "warn" : ["pending", "preparing", "acknowledged", "open"].includes(status) ? "info" : "neutral";
  return <span className={"status is-" + tone}><Icon name={tone === "ok" ? "checkCircle" : tone === "danger" ? "xCircle" : tone === "warn" ? "alertTriangle" : tone === "info" ? "clock" : "circle"} />{status.replaceAll("_", " ")}</span>;
}
export function PageHead({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) { return <div className="page-head"><div><h1 className="page-title" tabIndex={-1}>{title}</h1><p className="page-sub">{children}</p></div>{actions}</div>; }
export function Empty({ title, children, icon = "inbox" }: { title: string; children: ReactNode; icon?: string }) { return <div className="empty-state"><Icon name={icon} /><h2>{title}</h2><p>{children}</p></div>; }
export function LoadState({ loading, error, retry, children }: { loading: boolean; error: string; retry: () => void; children: ReactNode }) {
  if (loading) return <p role="status" className="composer-status"><Icon name="loader" className="spin" />Loading…</p>;
  if (error) return <Notice title="We couldn’t load this information" tone="danger"><p>{error} This is not an empty list.</p><button className="btn btn-secondary" onClick={retry}>Try again</button></Notice>;
  return children;
}
export function useAdminData<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const read = useCallback(() => {
    const id = ++sequence.current;
    return requestJson<T>(url).then(
      result => {
        if (id === sequence.current) { setData(result); setError(""); setLoading(false); }
        return result;
      },
      error => {
        if (id === sequence.current) { setData(null); setError(adminError(error)); setLoading(false); }
        return null;
      },
    );
  }, [url]);
  const reload = useCallback(() => {
    setLoading(true); setError("");
    return read();
  }, [read]);
  useEffect(() => {
    const id = ++sequence.current;
    let active = true;
    requestJson<T>(url).then(
      result => { if (active && id === sequence.current) { setData(result); setError(""); setLoading(false); } },
      error => { if (active && id === sequence.current) { setData(null); setError(adminError(error)); setLoading(false); } },
    );
    return () => { active = false; };
  }, [url]);
  return { data, setData, loading, error, reload };
}
export function DetailRows({ rows }: { rows: Array<[string, ReactNode]> }) { return <dl className="dl">{rows.map(([label, value]) => <div className="dl-row" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>; }
