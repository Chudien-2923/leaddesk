"use client";
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { agencyPolicySchema, type AgencyPolicy } from "@/domain/policy";
import type { KnowledgeDraft, KnowledgeInput, KnowledgeRelease } from "@/server/db/releases";
import { ApiError, requestJson } from "@/client/api";
import { formatDateTime, formatVnd, TIME_ZONE_LABEL } from "@/client/format";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { Dialog } from "@/components/ui/Dialog";
import { adminError, Badge, DetailRows, Empty, LoadState, PageHead, useAdminData } from "./Common";

type KnowledgeResponse = { drafts: KnowledgeRelease[]; active: { status: "ready" | "not_ready"; releaseId: string | null } };
type Publication = { releaseId: string; status: "preparing" | "ready" | "failed"; failureCode: string | null; createdAt: string; publishedAt: string | null };
type PendingPublication = { draftId: string; previous: string[] };
type Editor = KnowledgeInput & { releaseId?: string };
type SaveAttempt = { releaseId: string; method: "POST" | "PATCH"; input: KnowledgeInput };
const pendingKey = "leaddesk-admin-pending-publication";
const saveRecoveryKey = "leaddesk-admin-draft-recovery";
const kindLabels: Record<string, string> = { services: "Service", pricing: "Pricing", faq: "FAQ", policies: "Policy" };
function copyDraft(draft: KnowledgeRelease): Editor { return { releaseId: draft.releaseId, documents: draft.documents.map(document => ({ ...document })), policy: structuredClone(draft.policy) }; }
function serialized(editor: Editor): string { return JSON.stringify({ documents: editor.documents, policy: editor.policy }); }
function canonicalInput(input: KnowledgeInput): string {
  return JSON.stringify({
    documents: input.documents.map(document => ({
      documentId: document.documentId, title: document.title.trim(), body: document.body,
      kind: document.kind ?? "services", visibility: document.visibility ?? "public",
    })).sort((left, right) => (left.documentId ?? "").localeCompare(right.documentId ?? "")),
    policy: agencyPolicySchema.parse(input.policy),
  });
}
function validate(editor: Editor): string[] {
  const errors: string[] = [];
  if (editor.documents.length < 1 || editor.documents.length > 100) errors.push("A draft must contain between 1 and 100 documents.");
  editor.documents.forEach((document, index) => {
    if (!document.title.trim() || document.title.trim().length > 256) errors.push("Document " + (index + 1) + ": enter a title up to 256 characters.");
    if (!document.body.trim() || Array.from(document.body).length > 20000) errors.push("Document " + (index + 1) + ": enter text up to 20,000 characters.");
  });
  if (!agencyPolicySchema.safeParse(editor.policy).success) errors.push("Check the policy revision, service titles and whole-number VND amounts. Booking and timeline criteria must match the supported policy.");
  return errors;
}
function readRecoveryState(): { pending: PendingPublication | null; saveAttempt: SaveAttempt | null } {
  let pending: PendingPublication | null = null;
  let saveAttempt: SaveAttempt | null = null;
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    if (stored && typeof stored === "object" && "draftId" in stored && typeof stored.draftId === "string" && "previous" in stored && Array.isArray(stored.previous) && stored.previous.every(id => typeof id === "string")) pending = stored as PendingPublication;
  } catch { /* No saved publication uncertainty is available. */ }
  try {
    const attempt = JSON.parse(sessionStorage.getItem(saveRecoveryKey) ?? "null") as SaveAttempt | null;
    if (attempt && typeof attempt.releaseId === "string" && ["POST", "PATCH"].includes(attempt.method) && !validate(attempt.input).length && attempt.input.documents.every(document => typeof document.documentId === "string")) saveAttempt = attempt;
  } catch { /* Ignore unavailable or invalid local recovery data. */ }
  return { pending, saveAttempt };
}
const subscribeToHydration = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;
export default function Knowledge() {
  const mounted = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);
  return mounted ? <KnowledgeEditor /> : <div className="adm-page"><p role="status">Loading knowledge workspace…</p></div>;
}
function KnowledgeEditor() {
  const [recovery] = useState(readRecoveryState);
  const knowledge = useAdminData<KnowledgeResponse>("/api/admin/knowledge");
  const publications = useAdminData<{ publications: Publication[] }>("/api/auth/publications");
  const [editor, setEditor] = useState<Editor | null>(() => recovery.saveAttempt ? { ...recovery.saveAttempt.input, ...(recovery.saveAttempt.method === "PATCH" ? { releaseId: recovery.saveAttempt.releaseId } : {}) } : null); const [saved, setSaved] = useState(""); const [documentIndex, setDocumentIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState<"" | "template" | "save" | "delete" | "publish">(""); const lock = useRef(false);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(recovery.saveAttempt ? "Your unconfirmed draft save was restored. Check and recover the original save before editing." : ""); const [validation, setValidation] = useState<string[]>([]); const [uncertainSave, setUncertainSave] = useState(!!recovery.saveAttempt);
  const [saveAttempt, setSaveAttempt] = useState<SaveAttempt | null>(recovery.saveAttempt);
  const [pending, setPending] = useState<PendingPublication | null>(recovery.pending); const [confirmation, setConfirmation] = useState<"publish" | "delete-draft" | "delete-document" | "discard" | null>(null); const nextEditor = useRef<Editor | null>(null);
  const validationRef = useRef<HTMLDivElement>(null); const documentTitle = useRef<HTMLInputElement>(null);
  useEffect(() => { if (documentIndex !== null) documentTitle.current?.focus(); }, [documentIndex]);
  useEffect(() => { if (validation.length) validationRef.current?.focus(); }, [validation]);
  const dirty = !!editor && serialized(editor) !== saved; const currentDocument = editor && documentIndex !== null ? editor.documents[documentIndex] : null;
  const preparing = publications.data?.publications.some(publication => publication.status === "preparing") ?? false;
  function applyEditor(value: Editor | null) { setEditor(value); setSaved(value ? serialized(value) : ""); setDocumentIndex(null); setValidation([]); setError(""); setNotice(""); setUncertainSave(false); }
  function choose(value: Editor) { if (dirty) { nextEditor.current = value; setConfirmation("discard"); } else applyEditor(value); }
  async function newDraft() {
    if (lock.current) return; if (dirty) { setError("Save your current draft or select a saved draft to discard its local edits before starting another."); return; }
    lock.current = true; setBusy("template"); setError("");
    try { const template = await requestJson<KnowledgeInput>("/api/auth/knowledge-template"); applyEditor({ documents: template.documents.map(({ title, body, kind, visibility }) => ({ title, body, kind, visibility })), policy: template.policy }); setSaved(""); }
    catch (error) { setError(adminError(error)); } finally { lock.current = false; setBusy(""); }
  }
  function changeDocument(patch: Partial<KnowledgeDraft>) { setEditor(current => current && documentIndex !== null ? { ...current, documents: current.documents.map((document, index) => index === documentIndex ? { ...document, ...patch } : document) } : current); }
  function changeService(service: "meta_ads" | "google_ads", patch: Partial<AgencyPolicy["services"]["meta_ads"]>) { setEditor(current => current ? { ...current, policy: { ...current.policy, services: { ...current.policy.services, [service]: { ...current.policy.services[service], ...patch } } } } : current); }
  function clearSaveRecovery() {
    setSaveAttempt(null);
    try { sessionStorage.removeItem(saveRecoveryKey); } catch { /* In-memory recovery is already cleared. */ }
  }
  function acceptSavedDraft(result: KnowledgeRelease) {
    const next = copyDraft(result);
    setEditor(next); setSaved(serialized(next)); setUncertainSave(false); clearSaveRecovery();
    setNotice("Draft saved. Customer answers have not changed.");
  }
  async function sendSave(attempt: SaveAttempt) {
    const result = await requestJson<KnowledgeRelease>("/api/admin/knowledge", {
      method: attempt.method,
      body: JSON.stringify({ releaseId: attempt.releaseId, ...attempt.input }),
    });
    acceptSavedDraft(result);
    await knowledge.reload();
  }
  function handleSaveFailure(error: unknown) {
    const uncertain = !(error instanceof ApiError) || error.status === 0 || error.status >= 500 || error.status === 401;
    setUncertainSave(uncertain);
    if (!uncertain) clearSaveRecovery();
    setError(adminError(error));
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || lock.current || uncertainSave) return;
    const errors = validate(editor); setValidation(errors); if (errors.length) return;
    const input: KnowledgeInput = {
      documents: editor.documents.map(document => ({
        ...document, documentId: document.documentId ?? crypto.randomUUID(),
        title: document.title.trim(), kind: document.kind ?? "services", visibility: document.visibility ?? "public",
      })),
      policy: structuredClone(editor.policy),
    };
    const attempt: SaveAttempt = { releaseId: editor.releaseId ?? crypto.randomUUID(), method: editor.releaseId ? "PATCH" : "POST", input };
    setEditor({ ...input, ...(editor.releaseId ? { releaseId: editor.releaseId } : {}) });
    setSaveAttempt(attempt);
    try { sessionStorage.setItem(saveRecoveryKey, JSON.stringify(attempt)); }
    catch { setNotice("This browser cannot store recovery details. Keep this tab open until the save is confirmed."); }
    lock.current = true; setBusy("save"); setError("");
    try { await sendSave(attempt); }
    catch (error) { handleSaveFailure(error); }
    finally { lock.current = false; setBusy(""); }
  }
  async function recoverSave() {
    if (!saveAttempt || lock.current) return;
    lock.current = true; setBusy("save"); setError("");
    try {
      const latest = await knowledge.reload();
      if (!latest) { setError("The saved drafts could not be read. No save was repeated; your retained content is unchanged."); return; }
      const existing = latest.drafts.find(draft => draft.releaseId === saveAttempt.releaseId);
      if (existing) {
        if (canonicalInput(existing) !== canonicalInput(saveAttempt.input)) {
          setError("The saved draft has different content. Download your retained draft and compare the saved record before making another change. No overwrite was attempted.");
          return;
        }
        acceptSavedDraft(existing);
      } else {
        // The same release UUID and frozen payload are safe even if the first POST is still finishing.
        await sendSave(saveAttempt);
      }
    } catch (error) { handleSaveFailure(error); }
    finally { lock.current = false; setBusy(""); }
  }
  function downloadRetainedDraft() {
    if (!saveAttempt) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(saveAttempt.input, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "leaddesk-retained-draft.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  async function deleteDraft() {
    if (!editor?.releaseId || lock.current) return; const releaseId = editor.releaseId; lock.current = true; setBusy("delete"); setConfirmation(null); setError("");
    try { await requestJson("/api/admin/knowledge", { method: "DELETE", body: JSON.stringify({ releaseId }) }); applyEditor(null); setNotice("Draft deleted. The active release has not changed."); await knowledge.reload(); }
    catch (error) { setError(adminError(error) + " Refresh the saved drafts before repeating this action."); setUncertainSave(true); }
    finally { lock.current = false; setBusy(""); }
  }
  async function refresh() { if (lock.current) return; await Promise.all([knowledge.reload(), publications.reload()]); }
  async function publish() {
    if (!editor?.releaseId || dirty || lock.current || pending || preparing) return;
    if (!publications.data || publications.error) { setError("Publication status must be available before publishing. Refresh and try again."); return; }
    const record: PendingPublication = { draftId: editor.releaseId, previous: publications.data.publications.map(publication => publication.releaseId) };
    lock.current = true; setBusy("publish"); setConfirmation(null); setError(""); setNotice(""); setPending(record);
    try { sessionStorage.setItem(pendingKey, JSON.stringify(record)); } catch { /* In-memory guard remains active. */ }
    try {
      const response = await fetch("/api/admin/knowledge/publish", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ releaseId: editor.releaseId }) });
      const result: unknown = await response.json();
      if (typeof result === "object" && result !== null && "releaseId" in result && typeof result.releaseId === "string" && "state" in result && (result.state === "ready" || result.state === "failed")) {
        setPending(null); try { sessionStorage.removeItem(pendingKey); } catch { /* Storage may be unavailable. */ }
        if (result.state === "ready") setNotice("Release " + result.releaseId + " is ready. Your saved source draft remains available.");
        else setError("Publication failed. The previously active release and your saved draft are retained. Review publication status for the safe failure code.");
      } else {
        const code = typeof result === "object" && result !== null && "error" in result && typeof result.error === "object" && result.error !== null && "code" in result.error && typeof result.error.code === "string" ? result.error.code : "SERVICE_UNAVAILABLE";
        throw new ApiError(code, response.status);
      }
    } catch (error) {
      const rejectedBeforePublication = error instanceof ApiError && (
        error.status === 401 || error.status === 403 ||
        ["INVALID_REQUEST", "INVALID_JSON", "JSON_REQUIRED", "BODY_TOO_LARGE", "ORIGIN_FORBIDDEN"].includes(error.code)
      );
      if (rejectedBeforePublication) {
        setPending(null);
        try { sessionStorage.removeItem(pendingKey); } catch { /* In-memory state is already cleared. */ }
      }
      setError(adminError(error) + (rejectedBeforePublication
        ? " Publication did not start. Your saved draft is unchanged."
        : " Publication outcome is not confirmed. Check publication status; do not start another publication blindly."));
    }
    finally { await Promise.all([knowledge.reload(), publications.reload()]); lock.current = false; setBusy(""); }
  }
  return <div className="adm-page"><PageHead title="Knowledge" actions={<div className="flow-actions"><button className="btn btn-secondary btn-sm" disabled={!!busy || knowledge.loading} onClick={() => void refresh()}><Icon name="refresh" />Check status</button><button className="btn btn-secondary btn-sm" disabled={!!busy || knowledge.loading || !!knowledge.error || !!saveAttempt} onClick={() => void newDraft()}><Icon name="plus" />{busy === "template" ? "Loading…" : "New draft"}</button></div>}>Customer answers use only the active release. Drafts aren’t used until they are explicitly published.</PageHead>
    {error && <Notice title="Action not confirmed" tone="danger">{error}</Notice>}{notice && <Notice title="Knowledge status" tone="info">{notice}</Notice>}
    {uncertainSave && saveAttempt && <Notice title="Recover the original draft save" tone="warn"><p>Your exact content and draft ID are retained in this tab’s recovery storage. Recovery first reads saved drafts using <span className="mono">{saveAttempt.releaseId}</span>. If the original save is present with the same content, it is confirmed; otherwise only the same ID and frozen content are submitted again, never a new draft request.</p><div className="flow-actions"><button type="button" className="btn btn-primary" disabled={!!busy} onClick={() => void recoverSave()}>{busy === "save" ? "Checking save…" : "Check and recover save"}</button><button type="button" className="btn btn-secondary" onClick={downloadRetainedDraft}>Download retained draft</button></div></Notice>}
    {pending && <Notice title={busy === "publish" ? "Publication request in progress" : "Publication outcome needs checking"} tone="warn"><p>Your source draft <span className="mono">{pending.draftId}</span> is retained. You can edit and save drafts, but another publication is locked to avoid repeating an uncertain request. Check the active release and publication history below. History cannot automatically identify which release belongs to a lost response; agency technical support must resolve that uncertainty before another publication.</p><button type="button" className="btn btn-secondary btn-sm" disabled={!!busy} onClick={() => void refresh()}>Check publication status</button></Notice>}
    <LoadState loading={knowledge.loading} error={knowledge.error} retry={() => void knowledge.reload()}><div className="release-grid"><section className="release-card is-active"><div className="release-head"><h2 className="release-name">Active release</h2><Badge status={knowledge.data?.active.status === "ready" ? "ready" : "not_ready"} /></div>{knowledge.data?.active.releaseId ? <><p className="mono">{knowledge.data.active.releaseId}</p><p className="field-hint">Ready — used in customer answers.</p></> : <p>No compatible ready release is active. Drafts are not used in answers.</p>}</section><section className="release-card"><div className="release-head"><h2 className="release-name">Saved drafts</h2><Badge status="draft" /></div><p>Each draft contains its complete document set and structured policy. Publishing creates a separate immutable release.</p><p className="field-hint">{knowledge.data?.drafts.length ?? 0} saved drafts</p></section></div>
    {!!knowledge.data?.drafts.length && <section className="detail-section"><h2 className="section-h">Choose a saved draft</h2><div className="list" role="list">{knowledge.data.drafts.map(draft => <div role="listitem" key={draft.releaseId}><button type="button" className="row-btn row-split" aria-current={editor?.releaseId === draft.releaseId} disabled={!!busy || !!saveAttempt} onClick={() => choose(copyDraft(draft))}><span className="row-main"><span className="row-title">{draft.documents[0]?.title || "Knowledge draft"}</span><span className="row-meta mono">{draft.releaseId}</span><span className="row-meta">{draft.documents.length} documents · Policy {draft.policy.version}</span></span><Icon name="chevronRight" /></button></div>)}</div></section>}
    {!editor && !knowledge.data?.drafts.length && <Empty title="No saved drafts" icon="book">Choose New draft to start from the current active release, or the approved agency dataset if no release is active. Nothing is created until you save.</Empty>}</LoadState>
    {editor && <form className="form" onSubmit={save} aria-label="Knowledge draft editor"><fieldset disabled={!!busy || (uncertainSave && !!saveAttempt)}><div className="detail-section"><div className="page-head"><div><h2 className="section-h">{editor.releaseId ? "Edit saved draft" : "New unsaved draft"}</h2><p className="field-hint">{dirty ? "Unsaved changes — save before publishing." : "All changes in this draft are saved."}</p></div><Badge status="draft" /></div>
      {validation.length > 0 && <div className="callout is-danger admin-validation" role="alert" tabIndex={-1} ref={validationRef}><div className="callout-body"><p className="callout-title">Check the draft before saving</p><ul>{validation.map(message => <li key={message}>{message}</li>)}</ul><a href="#kb-documents">Review documents and policy</a></div></div>}
      {uncertainSave && !saveAttempt && <Notice title="Deletion was not confirmed" tone="warn">Your inputs are retained. Check status, then select the saved draft if it still exists before making another change.</Notice>}
      <section className="detail-section" id="kb-documents"><div className="page-head"><h3 className="section-h">Documents</h3><button type="button" className="btn btn-secondary btn-sm" disabled={editor.documents.length >= 100} onClick={() => { setEditor({ ...editor, documents: [...editor.documents, { title: "", body: "", kind: "services", visibility: "public" }] }); setDocumentIndex(editor.documents.length); }}><Icon name="plus" />New document</button></div><div className="list" role="list"><div className="list-head cols-docs" aria-hidden="true"><span>Title</span><span>Type</span><span>Visibility</span><span>Characters</span><span /></div>{editor.documents.map((document, index) => <div role="listitem" key={document.documentId ?? index}><button className="row-btn cols-docs" type="button" aria-current={documentIndex === index} onClick={() => setDocumentIndex(index)}><span className="row-main"><span className="row-title">{document.title || "Untitled document"}</span><span className="row-meta">Draft</span></span><span className="row-cell col-type">{kindLabels[document.kind ?? "services"]}</span><span className="row-cell col-status">{document.visibility ?? "public"}</span><span className="row-cell col-updated">{Array.from(document.body).length.toLocaleString("en-US")}</span><Icon name="chevronRight" className="chev" /></button></div>)}</div></section>
      {currentDocument && <section className="editor-grid" aria-label="Document editor"><div className="form"><div className="field"><label className="field-label" htmlFor="kb-title">Title</label><input id="kb-title" ref={documentTitle} className="input" required maxLength={256} value={currentDocument.title} onChange={event => changeDocument({ title: event.target.value })} /></div><div className="field-row"><div className="field"><label className="field-label" htmlFor="kb-kind">Document type</label><select id="kb-kind" className="select" value={currentDocument.kind ?? "services"} onChange={event => changeDocument({ kind: event.target.value as KnowledgeDraft["kind"] })}>{Object.entries(kindLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div><div className="field"><label className="field-label" htmlFor="kb-visibility">Visibility</label><select id="kb-visibility" className="select" value={currentDocument.visibility ?? "public"} onChange={event => changeDocument({ visibility: event.target.value as KnowledgeDraft["visibility"] })}><option value="public">Public — available for answers</option><option value="internal">Internal — excluded from customer sources</option></select></div></div><div className="field"><div className="od-row"><label className="field-label" htmlFor="kb-body">Content (Markdown)</label><span className={"counter" + (Array.from(currentDocument.body).length > 20000 ? " is-over" : "")} id="kb-counter">{Array.from(currentDocument.body).length.toLocaleString("en-US")} / 20,000</span></div><p className="field-hint" id="kb-body-hint">Text and Markdown only. Write in English; published public text can be quoted in customer answers.</p><textarea id="kb-body" className="textarea code" required aria-describedby="kb-body-hint kb-counter" value={currentDocument.body} onChange={event => changeDocument({ body: event.target.value })} /></div><div className="admin-document-actions"><button type="button" className="btn btn-secondary" onClick={() => setDocumentIndex(null)}>Close document</button><button type="button" className="btn btn-danger" disabled={editor.documents.length <= 1} onClick={() => setConfirmation("delete-document")}><Icon name="trash" />Remove from draft</button></div><p className="field-hint">A draft requires at least one document. Document edits and removals are stored only when you save the full draft.</p></div><aside className="editor-side"><Notice title="Publishing is separate" tone="info">Saving does not change the active release. Public documents, search vectors and policy activate together only after preparation succeeds. Internal documents never become customer sources.</Notice></aside></section>}
      <section className="detail-section"><h3 className="section-h">Structured pricing and qualification</h3><p className="field-hint">These values are published with the documents. A published revision is immutable: use a new revision whenever policy content changes.</p><div className="policy-grid"><div className="field"><label className="field-label" htmlFor="kb-revision">Policy revision ID</label><input className="input mono" id="kb-revision" required minLength={1} maxLength={128} value={editor.policy.version} onChange={event => setEditor({ ...editor, policy: { ...editor.policy, version: event.target.value } })} aria-describedby="kb-revision-hint" /><p className="field-hint" id="kb-revision-hint">1–128 characters. Reusing a published ID with changed content will be rejected.</p></div>{(["meta_ads", "google_ads"] as const).map(service => { const value = editor.policy.services[service]; return <fieldset className="policy-service" key={service}><legend>{service === "meta_ads" ? "Meta Ads" : "Google Ads"}</legend><div className="field"><label className="field-label" htmlFor={service + "-title"}>Service title</label><input className="input" id={service + "-title"} required value={value.title} onChange={event => changeService(service, { title: event.target.value })} /></div><div className="field-row">{([["managementMonthlyVnd", "Management fee (VND per month)"], ["minimumMediaMonthlyVnd", "Minimum ad spend (VND per month)"]] as const).map(([name, label]) => <div className="field" key={name}><label className="field-label" htmlFor={service + name}>{label}</label><input className="input" type="number" inputMode="numeric" min={0} max={Number.MAX_SAFE_INTEGER} step={1} required id={service + name} value={Number.isFinite(value[name]) ? value[name] : ""} onChange={event => changeService(service, { [name]: event.target.value === "" ? NaN : Number(event.target.value) })} /></div>)}</div><p className="policy-derived">Minimum combined budget: <strong>{Number.isSafeInteger(value.managementMonthlyVnd + value.minimumMediaMonthlyVnd) ? formatVnd(value.managementMonthlyVnd + value.minimumMediaMonthlyVnd) : "Check amounts"}</strong></p><label className="check"><input type="checkbox" checked={value.requiresWebsite} onChange={event => changeService(service, { requiresWebsite: event.target.checked })} /><span className="check-text">A website is required</span></label></fieldset>; })}<div className="admin-policy-fixed"><h4 className="panel-h">Supported scheduling and start criteria</h4><DetailRows rows={[["Start window", editor.policy.timelineDays + " days"], ["Time zone", editor.policy.booking.timeZone], ["Consultation", editor.policy.booking.durationMinutes + " minutes"], ["Schedule", "Monday–Friday · " + editor.policy.booking.workingBlocks.map(block => block.join("–")).join(" and ")], ["Booking window", editor.policy.booking.leadHours + " hours’ notice · " + editor.policy.booking.horizonDays + " days ahead"], ["Slot grid", editor.policy.booking.gridMinutes + " minutes"]]} /><p className="field-hint">These criteria are fixed by the current policy schema and cannot be changed in this editor.</p></div></div></section>
      <div className="flow-actions"><button className="btn btn-primary" type="submit" disabled={!dirty || uncertainSave}>{busy === "save" ? "Saving…" : "Save draft"}</button><button type="button" className="btn btn-secondary" disabled={!editor.releaseId || dirty || uncertainSave || preparing || !!pending || !publications.data || !!publications.error} onClick={() => setConfirmation("publish")}>Publish saved draft</button>{editor.releaseId && <button type="button" className="btn btn-danger" disabled={uncertainSave || pending?.draftId === editor.releaseId} onClick={() => setConfirmation("delete-draft")}>Delete draft</button>}</div></div></fieldset></form>}
    <section className="detail-section"><h2 className="section-h">Publication status</h2>{publications.loading ? <p role="status">Loading publication status…</p> : publications.error ? <Notice title="Publication status is unavailable" tone="warn">{publications.error} Publishing is unavailable until current status can be checked.</Notice> : !publications.data?.publications.length ? <p className="field-hint">No publication records for this administrator.</p> : <div className="list" role="list">{publications.data.publications.map(publication => <div role="listitem" key={publication.releaseId} className="row-btn row-split"><span className="row-main"><span className="row-title mono">{publication.releaseId}</span><span className="row-meta">{formatDateTime(publication.publishedAt ?? publication.createdAt)} · {TIME_ZONE_LABEL}</span>{publication.status === "failed" && <span className="row-meta">{publication.failureCode === "POLICY_VERSION_CONFLICT" ? "Policy revision already describes different content. Choose a new revision." : "Knowledge preparation failed. Your saved source draft is retained."}</span>}</span><Badge status={publication.status} /></div>)}</div>}</section>
    {confirmation && <Dialog title={confirmation === "publish" ? "Publish this saved draft?" : confirmation === "delete-draft" ? "Delete this draft?" : confirmation === "delete-document" ? "Remove this document?" : "Discard unsaved changes?"} onClose={() => setConfirmation(null)}><p>{confirmation === "publish" ? "All saved documents and policy will be prepared together. The current active release remains until preparation succeeds." : confirmation === "delete-draft" ? "This permanently deletes the editable draft, not the active release." : confirmation === "delete-document" ? "This removes the document from your local draft. Save the full draft to store the removal." : "Your local edits will be replaced by the selected saved draft."}</p><div className="flow-actions"><button type="button" className="btn btn-secondary" onClick={() => setConfirmation(null)}>Cancel</button><button type="button" className={"btn " + (confirmation.startsWith("delete") ? "btn-danger" : "btn-primary")} onClick={() => { if (confirmation === "publish") void publish(); else if (confirmation === "delete-draft") void deleteDraft(); else if (confirmation === "delete-document" && editor && documentIndex !== null) { setEditor({ ...editor, documents: editor.documents.filter((_, index) => index !== documentIndex) }); setDocumentIndex(null); setConfirmation(null); } else if (confirmation === "discard") { applyEditor(nextEditor.current); setConfirmation(null); } }}>{confirmation === "publish" ? "Publish saved draft" : confirmation === "delete-draft" ? "Delete draft" : confirmation === "delete-document" ? "Remove document" : "Discard local edits"}</button></div></Dialog>}
  </div>;
}
