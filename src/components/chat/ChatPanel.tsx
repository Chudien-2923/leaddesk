"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import type { ConversationEvent } from "@/server/conversation/state";
import type { PublicChatView } from "@/server/conversation/public-view";
import { ApiError, requestJson } from "@/client/api";
import { emptyContact, emptyDraft, eventFingerprint, forgetDraft, loadDraft, loadRecovery, saveDraft, type ConsultationDraft, type ContactDraft, type SavedIntent } from "@/client/consultation-state";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import ConsultationSummary from "./ConsultationSummary";
import ConsultationFlow from "./ConsultationFlow";

const suggestions = ["What does Meta Ads management cost?", "Do I need a website for Google Ads?", "Which service fits my business?"];
function safeMessage(error: unknown): string {
  if (error instanceof Error && error.message === "SESSION_LOST") return "Your saved consultation session is unavailable. No replacement session will be created automatically. Keep your request references and contact the agency for help.";
  return error instanceof ApiError ? error.message : "We couldn’t reach LeadDesk. Check your connection, then refresh the saved status before trying again.";
}
export default function ChatPanel() {
  const [view, setView] = useState<PublicChatView | null>(null);
  const viewRef = useRef<PublicChatView | null>(null);
  const [draft, setDraft] = useState<ConsultationDraft>(emptyDraft);
  const draftRef = useRef(draft);
  const messageRevision = useRef(0);
  const storageId = useRef("initial");
  const recoveryBlocked = useRef(false);
  const [lostSession, setLostSession] = useState(false);
  const [recoveryInfo, setRecoveryInfo] = useState<{ conversationId: string | null; unavailable: boolean }>({ conversationId: null, unavailable: false });
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState(false);
  const [tab, setTab] = useState<"chat" | "flow">("chat");
  const [privacy, setPrivacy] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [seenMessageCount, setSeenMessageCount] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const follow = useRef(true);
  const mounted = useRef(false);

  const updateDraft = useCallback((next: ConsultationDraft) => {
    draftRef.current = next;
    setDraft(next);
    const saved = saveDraft(storageId.current, next);
    setStorageError(!saved);
    return saved;
  }, []);

  const acceptView = useCallback((next: PublicChatView) => {
    if (storageId.current !== next.conversationId) {
      const restored = loadDraft(next.conversationId);
      if (storageId.current === "initial" && !restored.message) restored.message = draftRef.current.message;
      storageId.current = next.conversationId;
      draftRef.current = restored;
      setDraft(restored);
      forgetDraft("initial");
    }
    let current = draftRef.current;
    let intents = current.intents.map(intent => {
      if (intent.event.type === "message" && intent.uncertain) {
        const previous = new Set(intent.baselineMessageIds ?? []);
        const sentText = intent.event.text;
        if (next.messages.some(message => message.role === "user" && message.text === sentText && !previous.has(message.id))) {
          return null;
        }
      }
      if (intent.event.type === "submit_contact" && next.crm.status === "saved") return null;
      if (intent.event.type === "request_handoff" && next.handoff) return null;
      if (intent.event.type === "confirm_slot" && next.booking?.status === "booked") return null;
      if (intent.event.type === "submit_contact" && next.crm.operationId && next.crm.status !== "none") return { ...intent, uncertain: false };
      if (intent.event.type === "confirm_slot" && next.booking?.operationId) return { ...intent, uncertain: false };
      return intent;
    }).filter((intent): intent is SavedIntent => intent !== null);
    if (next.handoff) current = { ...current, handoff: emptyContact() };
    if (next.crm.status === "saved" || next.booking?.status === "booked") current = { ...current, contact: emptyContact() };
    if (next.crm.status === "saved") intents = intents.filter(intent => intent.event.type !== "submit_contact");
    updateDraft({ ...current, intents });
    viewRef.current = next;
    setRecoveryInfo({ conversationId: next.conversationId, unavailable: false });
    if (follow.current) setSeenMessageCount(next.messages.length);
    setView(next);
  }, [updateDraft, setSeenMessageCount]);

  const readView = useCallback(async (): Promise<PublicChatView | null> => {
    try {
      const next = await requestJson<PublicChatView>("/api/conversations", { cache: "no-store" });
      if (storageId.current !== "initial" && storageId.current !== next.conversationId) {
        recoveryBlocked.current = true;
        setLoaded(false);
        setLostSession(true);
        setRecoveryInfo({ conversationId: storageId.current, unavailable: true });
        throw new Error("SESSION_LOST");
      }
      acceptView(next);
      recoveryBlocked.current = false;
      setLostSession(false);
      setLoaded(true);
      return next;
    } catch (failure) {
      if (failure instanceof ApiError && (failure.status === 401 || failure.code === "CONVERSATION_FORBIDDEN")) {
        if (storageId.current !== "initial" || recoveryBlocked.current || viewRef.current || draftRef.current.intents.length) {
          recoveryBlocked.current = true;
          setLoaded(false);
          setLostSession(true);
          setRecoveryInfo({ conversationId: storageId.current === "initial" ? null : storageId.current, unavailable: true });
          throw new Error("SESSION_LOST");
        }
        viewRef.current = null;
        setView(null);
        setLoaded(true);
        return null;
      }
      throw failure;
    }
  }, [acceptView]);

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    const recovery = loadRecovery();
    recoveryBlocked.current = recovery.unavailable;
    storageId.current = recovery.conversationId ?? "initial";
    const restored = loadDraft(storageId.current);
    draftRef.current = restored;
    setDraft(restored);
    void readView().catch(failure => setError(safeMessage(failure)));
  }, [readView]);

  useEffect(() => {
    const input = textarea.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }, [draft.message, tab]);
  useEffect(() => {
    if (!scroll.current || tab !== "chat") return;
    if (follow.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [view?.messages.length, draft.intents, busy, tab]);

  async function refresh() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try { await readView(); setAnnouncement("Saved consultation status refreshed. This did not reconcile external operations."); }
    catch (failure) { setError(safeMessage(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function refreshAvailability() {
    if (busyRef.current || !viewRef.current?.allowedActions.includes("select_slot")) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const current = await readView();
      if (!current?.allowedActions.includes("select_slot")) return;
      const next = await requestJson<PublicChatView>(`/api/conversations/${encodeURIComponent(current.conversationId)}/availability`, { cache: "no-store" });
      acceptView(next);
      if (next.safeError) setError(next.safeError.message);
      setAnnouncement(next.safeError ? "Availability could not be loaded." : "Calendar availability refreshed.");
    } catch (failure) { setError(safeMessage(failure)); }
    finally { busyRef.current = false; setBusy(false); }
  }

  async function send(input: ConversationEvent, retryIntent?: SavedIntent) {
    if (busyRef.current || !loaded || recoveryBlocked.current) return;
    if (input.type === "message" && (!input.text.trim() || input.text.trim().length > 4000)) return;
    if (!retryIntent && draftRef.current.intents.some(intent => intent.uncertain)) {
      setError("An earlier request is not confirmed. Refresh its saved status and resolve that request before sending another.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError("");
    let event = input;
    let intent: SavedIntent | undefined;
    let started = false;
    const submittedRevision = messageRevision.current;
    let composerCleared = false;
    try {
      // Always read first: a previous response may have been lost, or the policy may have changed.
      const consentVersion = viewRef.current ? `${viewRef.current.factsVersion}:${viewRef.current.policyVersion}:${viewRef.current.factsValidationPending}` : null;
      let current = await readView();
      if (retryIntent && !draftRef.current.intents.some(item => item.fingerprint === retryIntent.fingerprint)) return;
      if (!current) {
        if (input.type !== "message") { setError("Start the consultation with a message first."); return; }
        current = await requestJson<PublicChatView>("/api/conversations", { method: "POST", body: JSON.stringify({ acceptedDemoNotice: true }) });
        acceptView(current);
      }
      if (current && ["submit_contact", "request_handoff", "confirm_slot"].includes(event.type) && consentVersion !== `${current.factsVersion}:${current.policyVersion}:${current.factsValidationPending}`) {
        setError("Your consultation information changed. Review the refreshed details and give consent or confirmation again.");
        return;
      }
      if (!current.allowedActions.includes(event.type)) { setError("That action is no longer available. Review the refreshed consultation and its current next steps."); return; }
      if (event.type === "submit_contact" && ["partial", "unknown", "failed"].includes(current.crm.status) || event.type === "confirm_slot" && current.booking && ["pending", "unknown", "booked"].includes(current.booking.status)) {
        setError("This operation already has a recorded outcome. Keep its original reference and ask the agency administrator to review it; do not create another copy.");
        return;
      }
      if ("factsVersion" in event && event.factsVersion !== current.factsVersion || event.type === "confirm_slot" && current.selectedSlot?.startUtc !== event.startUtc) {
        setError("Your information or selected time changed. Review the updated next step and give consent or confirmation again.");
        return;
      }
      if (event.type !== "select_slot") {
        const fingerprint = eventFingerprint(event);
        const prior = draftRef.current.intents.find(item => item.fingerprint === fingerprint);
        if ("key" in event) event = { ...event, key: prior && "key" in prior.event ? prior.event.key : crypto.randomUUID() };
        intent = { event, fingerprint, uncertain: true, ...(event.type === "message" ? { baselineMessageIds: current.messages.filter(message => message.role === "user").map(message => message.id) } : {}) };
        const intents = [...draftRef.current.intents.filter(item => item.fingerprint !== fingerprint), intent];
        const previousDraft = draftRef.current;
        composerCleared = event.type === "message" && !retryIntent && messageRevision.current === submittedRevision;
        if (!updateDraft({ ...previousDraft, intents, message: composerCleared ? "" : previousDraft.message })) {
          updateDraft(previousDraft);
          setError("Browser session storage is unavailable. Enable it before submitting so an interrupted request can be recovered safely.");
          return;
        }
      }
      started = true;
      const next = await requestJson<PublicChatView>(`/api/conversations/${encodeURIComponent(current.conversationId)}/events`, { method: "POST", body: JSON.stringify(event) });
      if (intent) {
        const completed = draftRef.current.intents.map(item => item.fingerprint === intent!.fingerprint ? { ...item, uncertain: false } : item);
        updateDraft({ ...draftRef.current, intents: completed.filter(item => event.type !== "message" || item.fingerprint !== intent!.fingerprint) });
      }
      acceptView(next);
      if (next.safeError) setError(next.safeError.message);
      setAnnouncement(next.safeError ? "The request could not be completed. Review its saved status." : event.type === "message" ? "New reply from LeadDesk." : "Consultation updated.");
    } catch (failure) {
      const rateLimited = input.type === "message" && failure instanceof ApiError && failure.code === "RATE_LIMITED" && failure.status === 429;
      // This typed rejection happens before message dispatch. A rate-limited retry does not settle the earlier uncertain request.
      if (rateLimited && intent && !retryIntent) {
        const fingerprint = intent.fingerprint;
        updateDraft({ ...draftRef.current, intents: draftRef.current.intents.filter(item => item.fingerprint !== fingerprint), message: composerCleared && messageRevision.current === submittedRevision ? input.text : draftRef.current.message });
      }
      setError(rateLimited ? safeMessage(failure) : started && intent ? "The response was interrupted. The request may have been received. Refresh the saved status before deciding whether to retry; your original request reference is retained." : safeMessage(failure));
      if (started && !rateLimited) {
        try { await readView(); }
        catch { /* Keep the durable uncertain intent and the visitor’s drafts. */ }
      }
    } finally { busyRef.current = false; setBusy(false); }
  }

  function showFlow() { setTab("flow"); setSheet(false); requestAnimationFrame(() => document.getElementById("cx-flow")?.focus()); }
  const uncertain = draft.intents.filter(intent => intent.uncertain);
  const lockedKinds = uncertain.map(intent => intent.event.type);
  const summaryProps = { view, next: showFlow, privacy: () => setPrivacy(true) };
  const pendingMessages = uncertain.filter(intent => intent.event.type === "message");
  const hasSteps = !!view && (view.messages.length > 0 || view.handoff !== null);
  const sendDisabled = busy || !loaded || lostSession || !draft.message.trim() || uncertain.length > 0 || !!view && !view.allowedActions.includes("message");
  const jump = (view?.messages.length ?? 0) > seenMessageCount;
  const recoveryNotice = !busy && uncertain.length > 0 && <Notice tone="warn" title="An earlier response is not confirmed"><p>We haven’t confirmed the outcome of your earlier request. Check its saved status before trying again. If it remains unresolved, ask our team to review the original request.</p><div className="callout-actions"><button className="btn btn-secondary btn-sm" type="button" onClick={() => void refresh()} disabled={busy}>Refresh saved status</button>{uncertain.map(intent => <button type="button" className="btn btn-secondary btn-sm" key={intent.fingerprint} disabled={busy || intent.event.type === "submit_contact" && !!view && view.crm.status !== "none" || intent.event.type === "confirm_slot" && !!view?.booking && ["pending", "unknown", "booked", "failed"].includes(view.booking.status)} onClick={() => void send(intent.event, intent)}>Check before retrying original {intent.event.type === "message" ? "message" : "request"}</button>)}</div>{uncertain.map(intent => "key" in intent.event && <p className="ref" key={intent.fingerprint}>Original request key <span className="mono">{intent.event.key}</span></p>)}</Notice>;
  return <div className="cx" id="view-customer">
    <a className="skip-link" href="#cx-main">Skip to main content</a>
    <header className="cx-header"><Link className="brand" href="/" aria-label="LeadDesk consultation home"><Image src="/brand/leaddesk-horizontal.svg" width={192} height={49} alt="LeadDesk" unoptimized /></Link>{hasSteps && <nav className="cx-tabs" aria-label="Consultation sections"><button type="button" className="cx-tab" aria-current={tab === "chat" ? "page" : undefined} onClick={() => setTab("chat")}><Icon name="message" />Conversation</button><button type="button" className="cx-tab" aria-current={tab === "flow" ? "page" : undefined} onClick={showFlow}><Icon name="calendar" />Next steps</button></nav>}<div className="cx-header-end"><button type="button" className="btn btn-secondary btn-sm only-narrow" aria-haspopup="dialog" onClick={() => setSheet(true)}><Icon name="list" />Summary</button></div></header>
    <div className="cx-body"><main className="cx-main" id="cx-main" tabIndex={-1}>
      <section className="cx-chat" aria-label="Conversation" hidden={tab !== "chat"}>
        <div className="cx-scroll od-scroll" ref={scroll} onScroll={() => { const element = scroll.current; if (!element) return; follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 140; if (follow.current) setSeenMessageCount(view?.messages.length ?? 0); }}><div className="cx-thread">
          {!view?.messages.length && !pendingMessages.length ? <section className="intro" aria-labelledby="intro-title">
            <h1 className="display" id="intro-title">Questions about advertising with us? Ask here.</h1>
            <p className="lede">Get clear answers on our Meta Ads and Google Ads services, pricing and minimum budgets. If it’s a good fit, you can book a 30-minute consultation with our team.</p>
            <ul className="intro-facts"><li><Icon name="wallet" />Prices in VND</li><li><Icon name="clock" />30-minute consultations</li></ul>
            <h2 className="suggest-title" id="suggest-title">Suggested questions</h2>
            <ul className="suggestions" aria-labelledby="suggest-title" style={{ listStyle: "none" }}>{suggestions.map(question => <li key={question}><button type="button" className="suggestion" onClick={() => { messageRevision.current++; updateDraft({ ...draftRef.current, message: question }); textarea.current?.focus(); }}><Icon name="message" /><span>{question}</span></button></li>)}</ul>
            <p className="suggest-note">Choosing a suggestion adds it to the message box. Nothing is sent until you press Send.</p>
          </section> : <><h1 className="sr-only">Consultation</h1>{view?.messages.map(message => message.role === "user"
            ? <div className="msg msg-user" key={message.id}><p className="sr-only">You:</p><div className="bubble">{message.text}</div></div>
            : <article className="msg msg-ai" key={message.id} aria-label="LeadDesk assistant">
              <div className="avatar" aria-hidden="true"><Image src="/brand/leaddesk-symbol-small.svg" width={22} height={22} alt="" unoptimized /></div>
              <div className="msg-main"><p className="msg-who">LeadDesk assistant</p><div className="msg-body" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text.split(/\n\s*\n/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div></div>
            </article>)}</>}
          {pendingMessages.map(intent => intent.event.type === "message" && <div className="msg msg-user" key={intent.fingerprint}><p className="sr-only">You:</p><div className="bubble">{intent.event.text}<p className="text-xs muted">{busy ? "Sending…" : "Delivery not confirmed"}</p></div></div>)}
          {busy && <p className="composer-status" role="status"><Icon name="loader" className="spin" />Updating your consultation… You can keep typing.</p>}
        </div></div>
        {jump && <button type="button" className="jump-latest" onClick={() => { if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; follow.current = true; setSeenMessageCount(view?.messages.length ?? 0); }}><Icon name="arrowDown" />Latest reply</button>}
        <div className="cx-dock">
          {!loaded && !error && <p className="composer-status" role="status">Checking for an existing consultation…</p>}
          {error && <Notice tone="danger" title="Your consultation needs attention"><p>{error}</p><button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={busy}><Icon name="refresh" />Refresh saved status</button></Notice>}
          {lostSession && <Notice tone="warn" title="Original consultation recovery is locked">
            <p>This tab retains an earlier consultation, but its authorized visitor session is missing, rejected or different. No replacement conversation or request will be created automatically. Restore the original session or contact the agency with these references.</p>
            {recoveryInfo.conversationId && <p className="ref">Original conversation <span className="mono">{recoveryInfo.conversationId}</span></p>}
            {draft.intents.map(intent => "key" in intent.event && <p className="ref" key={intent.fingerprint}>Original request key <span className="mono">{intent.event.key}</span></p>)}
            {recoveryInfo.unavailable && <p>Automatic session recovery is unavailable. Sending remains locked to avoid duplicating an earlier request.</p>}
          </Notice>}
          {storageError && <Notice tone="warn" title="Session recovery storage is unavailable"><p>Your browser must allow session storage before submitting a request safely. Your current text remains on this page.</p></Notice>}
          {recoveryNotice}
          <form className="composer" onSubmit={event => { event.preventDefault(); void send({ type: "message", text: draftRef.current.message.trim() }); }}><label className="sr-only" htmlFor="composer-input">Your question</label><textarea ref={textarea} id="composer-input" rows={1} maxLength={4000} placeholder="Ask about services, pricing or getting started" aria-describedby="composer-notice composer-count" enterKeyHint="send" value={draft.message} onChange={event => { messageRevision.current++; updateDraft({ ...draftRef.current, message: event.target.value }); }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) { event.preventDefault(); if (!sendDisabled) void send({ type: "message", text: draftRef.current.message.trim() }); } }} /><button type="submit" className="btn-send" aria-label="Send" disabled={sendDisabled}><Icon name="arrowUp" /></button></form>
          <div className="composer-meta"><p className="composer-notice" id="composer-notice"><Icon name="shield" /><span>Your messages are stored by LeadDesk and shared with our AI provider to answer you. Please don’t include sensitive personal information. <button type="button" className="link-btn" onClick={() => setPrivacy(true)}>How we handle your data</button></span></p><p className="composer-count" id="composer-count" hidden={draft.message.length < 3600}>{draft.message.length.toLocaleString()} / 4,000</p></div>
        </div>
      </section>
      <section className="cx-flow" id="cx-flow" aria-label="Next steps" tabIndex={-1} hidden={tab !== "flow"}><div className="cx-scroll od-scroll"><div className="flow-inner">
        {error && <Notice title="Request needs attention" tone="danger"><p>{error}</p><button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void refresh()}>Refresh saved status</button></Notice>}
        {recoveryNotice}
        {view && <ConsultationFlow view={view} busy={busy} lockedKinds={lockedKinds} draft={draft} updateDraft={(kind: "contact" | "handoff", contact: ContactDraft) => { updateDraft({ ...draftRef.current, [kind]: contact }); }} send={event => send(event)} refresh={() => void refresh()} refreshAvailability={() => void refreshAvailability()} back={() => setTab("chat")} />}
      </div></div></section>
    </main><aside className="cx-aside" aria-label="Your consultation"><ConsultationSummary {...summaryProps} /></aside></div>
    {sheet && <Dialog title="Your consultation" sheet onClose={() => setSheet(false)}><ConsultationSummary {...summaryProps} /></Dialog>}
    {privacy && <Dialog title="How we handle your data" onClose={() => setPrivacy(false)}><p><strong>Your conversation.</strong> LeadDesk stores your messages so the consultation can continue, and sends them to our AI provider to generate answers.</p><p><strong>Answers.</strong> Answers use the agency’s published information. Missing information is not a reason to guess.</p><p><strong>Contact details.</strong> Contact details and a consultation summary are saved to the agency’s CRM only with your separate consent. A human review request goes to the agency’s local inbox with its own consent.</p><p><strong>Browser recovery.</strong> Drafts and interrupted requests are kept in this tab’s session storage for recovery, for up to 24 hours. Completed request details are cleared when no longer needed. No access tokens are stored there.</p><p><strong>What to avoid.</strong> Do not share passwords, payment details, ID numbers or other sensitive information.</p><p><strong>Bookings.</strong> Explicit confirmation adds an appointment to the agency calendar. This page does not send emails or calendar invitations.</p></Dialog>}
    <div className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</div>
  </div>;
}
