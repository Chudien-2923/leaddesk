"use client";

import { useEffect, useRef, useState } from "react";
import type { ConversationEvent } from "@/server/conversation/state";
import type { PublicChatView } from "@/server/conversation/public-view";
import type { ContactDraft } from "@/client/consultation-state";
import { contactSchema } from "@/domain/contact";
import { formatDate, formatTime, TIME_ZONE_LABEL } from "@/client/format";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";
import { AppointmentDetails, FactList, OperationStatus } from "./ConsultationSummary";

const shortDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "numeric", month: "short" });
const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short" });
type FormKind = "contact" | "handoff";
type Field = keyof ContactDraft | "consent";
type Errors = Partial<Record<Field, string>>;
const missingFieldLabels: Record<string, string> = {
  service: "Advertising service: Meta Ads, Google Ads, or both",
  business: "Business description",
  budget: "Monthly budget and whether it includes management fees",
  startDate: "Intended start date",
  hasWebsite: "Whether you have a website",
  acceptsManagementFee: "Acceptance of the separate management fee",
  conflicting_facts: "Clarification of conflicting information",
  latest_message_validation: "Confirmation of your latest information",
};
export interface FlowProps {
  view: PublicChatView;
  busy: boolean;
  lockedKinds: string[];
  draft: { contact: ContactDraft; handoff: ContactDraft };
  updateDraft: (kind: FormKind, draft: ContactDraft) => void;
  send: (event: ConversationEvent) => Promise<void>;
  refresh: () => void;
  refreshAvailability: () => void;
  back: () => void;
}
export default function ConsultationFlow({ view, busy, lockedKinds, draft, updateDraft, send, refresh, refreshAvailability, back }: FlowProps) {
  const [kind, setKind] = useState<FormKind>("contact");
  const [consents, setConsents] = useState<Record<FormKind, { version: string; checked: boolean }>>({ contact: { version: "", checked: false }, handoff: { version: "", checked: false } });
  const [errorRecord, setErrorRecord] = useState<{ key: string; errors: Errors }>({ key: "", errors: {} });
  const [day, setDay] = useState("");
  const summary = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const version = `${view.factsVersion}:${view.policyVersion}:${view.factsValidationPending}`;
  const formKey = `${version}:${kind}`;
  const errors: Errors = errorRecord.key === formKey ? errorRecord.errors : {};
  const consentChecked = consents[kind].version === version && consents[kind].checked;
  function setErrors(next: Errors | ((current: Errors) => Errors)) {
    setErrorRecord(current => ({ key: formKey, errors: typeof next === "function" ? next(current.key === formKey ? current.errors : {}) : next }));
  }
  useEffect(() => { heading.current?.focus(); }, [kind]);
  const isHandoff = kind === "handoff";
  const form = draft[kind];
  const allowContact = view.allowedActions.includes("submit_contact");
  const allowHandoff = view.allowedActions.includes("request_handoff") && !view.handoff;
  const allowSlots = view.allowedActions.includes("select_slot");
  const contactBlocked = lockedKinds.includes("submit_contact") || ["partial", "unknown", "failed"].includes(view.crm.status);
  const bookingBlocked = lockedKinds.includes("confirm_slot") || !!view.booking && ["pending", "unknown", "booked"].includes(view.booking.status);
  const handoffBlocked = lockedKinds.includes("request_handoff");
  const locked = busy || (isHandoff ? handoffBlocked : contactBlocked);
  const canForm = isHandoff ? allowHandoff : allowContact;
  const showContact = canForm && !(!isHandoff && allowSlots);
  const bookingFlowStarted = allowContact || allowSlots || view.crm.status !== "none" || !!view.booking;
  const title = isHandoff ? "Ask our team to review" : view.selectedSlot && !bookingBlocked ? "Review and confirm" : allowSlots && !bookingBlocked ? "Choose a time" : allowContact ? "Your contact details" : "Your next steps";
  const dates = view.safeError?.code === "CALENDAR_AVAILABILITY_UNAVAILABLE" ? [] : [...new Set(view.slots.map(slot => formatDate(slot.startUtc)))];
  const selectedDay = dates.includes(day) ? day : dates[0];
  function change(field: keyof ContactDraft, value: string) {
    updateDraft(kind, { ...form, [field]: value });
    setConsents(current => ({ ...current, [kind]: { version, checked: false } }));
    setErrors(current => ({ ...current, [field]: undefined }));
  }
  async function submit() {
    const nextErrors: Errors = {};
    const contact = { name: form.name.trim(), email: form.email.trim().toLowerCase(), ...(form.phone.trim() ? { phone: form.phone.trim() } : {}) };
    const validation = contactSchema.safeParse(contact);
    if (!validation.success) for (const issue of validation.error.issues) {
      const field = issue.path[0] as Field;
      nextErrors[field] = field === "name" ? "Enter a name of 1–120 characters." : field === "email" ? "Enter a valid email address, up to 254 characters." : "Enter a phone number of 3–32 characters, or leave it empty.";
    }
    if (isHandoff && (!form.reason.trim() || form.reason.trim().length > 4000)) nextErrors.reason = "Tell us what to review, using 1–4,000 characters.";
    if (!consentChecked) nextErrors.consent = "Review the information and tick the consent box to continue.";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) { requestAnimationFrame(() => summary.current?.focus()); return; }
    if (!validation.success || !canForm || locked) return;
    await send(isHandoff ? { type: "request_handoff", contact: validation.data, consent: true, reason: form.reason.trim(), key: "" } : { type: "submit_contact", contact: validation.data, consent: true, factsVersion: view.factsVersion, key: "" });
  }
  const fieldLabels: Record<Field, string> = { name: "Name", email: "Email", phone: "Phone", reason: "What should our team review?", consent: "Consent" };
  return <>
    <button type="button" className="back-btn" onClick={back}><Icon name="chevronLeft" />Back to conversation</button>
    <div className="flow-head"><h1 className="flow-title" tabIndex={-1} ref={heading}>{title}</h1><p className="flow-sub">{isHandoff ? "Save a request in the agency’s review inbox. This doesn’t book a consultation or send your details to the CRM." : bookingFlowStarted ? "Review your information before choosing and confirming a consultation." : "Check what is needed before online booking becomes available."}</p></div>
    {!isHandoff && bookingFlowStarted && <ol className="stepper" aria-label="Booking steps">{["Your details", "Choose a time", "Confirm"].map((label, index) => {
      const current = view.booking?.status === "booked" ? 3 : view.selectedSlot ? 2 : allowSlots ? 1 : 0;
      return <li key={label} className={`step ${index === current ? "is-current" : index < current ? "is-done" : "is-locked"}`} aria-current={index === current ? "step" : undefined}><span className="step-mark" aria-hidden="true"><Icon name={index < current ? "check" : index === current ? "circle" : "lock"} /></span><span className="step-text"><span className="step-label">{label}</span><span className="step-state">{index === current ? "Current step" : index < current ? "Completed" : "Not yet available"}</span></span></li>;
    })}</ol>}
    <OperationStatus view={view} refresh={refresh} busy={busy} />
    {view.factsValidationPending && <Notice title="Latest information is not validated yet" tone="warn"><p>Booking and CRM submission stay locked. Continue the conversation to clarify your plans, or request a human review.</p></Notice>}
    {showContact && <form className="form" noValidate onSubmit={event => { event.preventDefault(); void submit(); }}>
      {Object.keys(errors).some(key => errors[key as Field]) && <div className="error-summary" role="alert" tabIndex={-1} ref={summary}><h3><Icon name="alertCircle" />Please fix the following</h3><ul>{Object.entries(errors).filter(([, message]) => message).map(([field, message]) => <li key={field}><button className="link-btn" type="button" onClick={() => document.getElementById(`${kind}-${field}`)?.focus()}>{fieldLabels[field as Field]}: {message}</button></li>)}</ul></div>}
      <p className="field-hint">All fields are required unless marked optional. Changing these details clears consent so you can review them again.</p>
      <fieldset disabled={locked}><legend className="sr-only">{isHandoff ? "Human review contact" : "CRM contact"}</legend><div className="form"><div className="field-row">{(["name", "email"] as const).map(field => <div key={field} className={`field ${errors[field] ? "has-error" : ""}`}><label className="field-label" htmlFor={`${kind}-${field}`}>{fieldLabels[field]}</label><input className="input" id={`${kind}-${field}`} type={field === "email" ? "email" : "text"} autoComplete={field} maxLength={field === "name" ? 120 : 254} value={form[field]} onChange={event => change(field, event.target.value)} aria-required="true" aria-invalid={!!errors[field]} aria-describedby={errors[field] ? `${kind}-${field}-error` : undefined} />{errors[field] && <p className="field-error" id={`${kind}-${field}-error`}>{errors[field]}</p>}</div>)}</div>
      <div className={`field ${errors.phone ? "has-error" : ""}`}><label className="field-label" htmlFor={`${kind}-phone`}>Phone <span className="req">(optional)</span></label><input id={`${kind}-phone`} className="input" type="tel" autoComplete="tel" maxLength={32} value={form.phone} onChange={event => change("phone", event.target.value)} aria-invalid={!!errors.phone} aria-describedby={errors.phone ? `${kind}-phone-error` : undefined} />{errors.phone && <p className="field-error" id={`${kind}-phone-error`}>{errors.phone}</p>}</div>
      {isHandoff && <div className={`field ${errors.reason ? "has-error" : ""}`}><label className="field-label" htmlFor="handoff-reason">What should our team review?</label><textarea id="handoff-reason" className="textarea" maxLength={4000} value={form.reason} onChange={event => change("reason", event.target.value)} aria-required="true" aria-invalid={!!errors.reason} aria-describedby="handoff-reason-count handoff-reason-error" /><p className="counter" id="handoff-reason-count">{form.reason.length.toLocaleString()} / 4,000 characters</p><p className="field-error" id="handoff-reason-error">{errors.reason}</p></div>}
      <section className="panel-card transfer" aria-labelledby={`${kind}-transfer-title`}><h2 className="panel-card-h" id={`${kind}-transfer-title`}><Icon name="shield" />{isHandoff ? "What we’ll save in the agency’s review inbox" : "What we’ll save to the agency’s CRM"}</h2><div className="panel-section"><h3 className="panel-h">Contact</h3><dl className="dl">{(["name", "email", "phone"] as const).map(field => <div className="dl-row" key={field}><dt>{fieldLabels[field]}</dt><dd>{form[field] || (field === "phone" ? "Not provided" : "Not entered yet")}</dd></div>)}</dl></div>{isHandoff ? <div className="panel-section"><h3 className="panel-h">Review request</h3><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{form.reason || "Not entered yet"}</p></div> : <div className="panel-section"><h3 className="panel-h">Consultation note</h3><FactList facts={view.facts} /><p className="text-sm muted">Fit assessment: {view.qualification.status.replaceAll("_", " ")}{view.qualification.reasons.length ? ` · ${view.qualification.reasons.map(value => value.replaceAll("_", " ")).join(", ")}` : ""}</p></div>}<p className="transfer-note">{isHandoff ? "This request stays in the local agency review inbox; it does not create a CRM contact or a booking." : "We send the contact details and a summary, not the full conversation."}</p></section>
      <div className={`field ${errors.consent ? "has-error" : ""}`}><label className="check" htmlFor={`${kind}-consent`}><input type="checkbox" id={`${kind}-consent`} checked={consentChecked} onChange={event => { setConsents(current => ({ ...current, [kind]: { version, checked: event.target.checked } })); setErrors(current => ({ ...current, consent: undefined })); }} aria-invalid={!!errors.consent} aria-describedby={errors.consent ? `${kind}-consent-error` : undefined} /><span className="check-text">{isHandoff ? "I agree that LeadDesk may save my contact details and review request in the agency’s inbox so the team can follow up." : "I agree that LeadDesk may save my contact details and the summary above to the agency’s CRM so the team can prepare for and follow up on my consultation."}</span></label>{errors.consent && <p className="field-error" id={`${kind}-consent-error`}>{errors.consent}</p>}</div>
      <div className="flow-actions"><button type="submit" className="btn btn-primary" disabled={locked}>{busy ? "Saving…" : isHandoff ? "Save review request" : "Save and choose a time"}<Icon name="arrowRight" /></button><button type="button" className="btn btn-secondary" onClick={back}>Back to conversation</button></div></div></fieldset>
    </form>}
    {!isHandoff && allowSlots && !bookingBlocked && <>
      <div className="tz-line"><span><Icon name="clock" />30 minutes</span><span><Icon name="globe" />{TIME_ZONE_LABEL}</span></div>
      {view.selectedSlot ? <>
        <section className="panel-card"><h2 className="panel-card-h"><Icon name="calendar" />Consultation — not booked yet</h2><AppointmentDetails slot={view.selectedSlot} /></section>
        <section className="panel-card"><h2 className="panel-card-h">Contact</h2>
          {view.contact ? <dl className="dl"><div className="dl-row"><dt>Name</dt><dd>{view.contact.name}</dd></div><div className="dl-row"><dt>Email</dt><dd>{view.contact.email}</dd></div>{view.contact.phone && <div className="dl-row"><dt>Phone</dt><dd>{view.contact.phone}</dd></div>}</dl> : <p role="status">Saved contact details are unavailable. Refresh saved status before confirming.</p>}
          <p className="text-sm muted">The booking uses the contact and consultation note already saved. To change your plans, return to the conversation first.</p>
        </section>
        <div className="flow-actions"><button type="button" className="btn btn-primary" disabled={busy || !view.contact || !view.allowedActions.includes("confirm_slot")} onClick={() => { if (view.selectedSlot) void send({ type: "confirm_slot", startUtc: view.selectedSlot.startUtc, factsVersion: view.factsVersion, confirmed: true, key: "" }); }}>{busy ? "Confirming…" : "Confirm booking"}</button></div>
        <h2 className="section-h">Or choose another time</h2>
      </> : <p className="field-hint">Choose a time, then review it before confirming. Selecting a time does not book it.</p>}
      {dates.length ? <>
        <div className="slot-group"><h2 className="section-h" id="booking-dates">Date</h2><div className="date-grid" role="group" aria-labelledby="booking-dates">{dates.map(date => {
          const slots = view.slots.filter(slot => formatDate(slot.startUtc) === date);
          const instant = new Date(slots[0].startUtc);
          return <button className="date-cell" type="button" key={date} aria-label={date} aria-pressed={selectedDay === date} onClick={() => setDay(date)}><span className="date-dow">{weekday.format(instant)}</span><span className="date-day">{shortDate.format(instant)}</span><span className="date-avail">{slots.length} times</span></button>;
        })}</div></div>
        <div className="slot-group"><h2 className="section-h">Times on {selectedDay}</h2><div className="slot-grid">{view.slots.filter(slot => formatDate(slot.startUtc) === selectedDay).map(slot => <button type="button" className="slot" key={slot.startUtc} disabled={busy} aria-label={`${formatDate(slot.startUtc)}, ${formatTime(slot.startUtc)}–${formatTime(slot.endUtc)}, ${TIME_ZONE_LABEL}`} aria-pressed={view.selectedSlot?.startUtc === slot.startUtc} onClick={() => void send({ type: "select_slot", startUtc: slot.startUtc })}>{formatTime(slot.startUtc)}</button>)}</div></div>
      </> : <Notice title={view.safeError ? "Availability could not be loaded" : "No available times are currently listed"} tone={view.safeError ? "warn" : "neutral"}><p>{view.safeError ? "This is not confirmation that the calendar is full. Your contact remains saved. You can check availability again without submitting your contact a second time." : "No consultation times are available to choose right now. Check again later or ask our team to review your request."}</p></Notice>}
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={refreshAvailability}><Icon name="refresh" />{busy ? "Checking availability…" : "Refresh availability"}</button>
    </>}
    {!showContact && !allowContact && !allowSlots && !view.booking && !view.factsValidationPending && <Notice title="Booking is not available yet" tone={view.qualification.status === "needs_info" ? "info" : "warn"}>
      <p>{view.qualification.status === "needs_info"
        ? "We still need a little more information before checking your booking eligibility."
        : view.qualification.status === "not_qualified"
          ? "Your current plans do not meet the online booking requirements. Continue the conversation to review the requirements or discuss other options with our team."
          : view.qualification.status === "manual_review"
            ? "Your request needs a team review before online booking is available."
            : "An earlier operation needs review before you can choose a time. Check its saved status; do not submit another copy."}</p>
      {view.missingFields.length > 0 && <><p>Still needed:</p><ul>{view.missingFields.map(field => <li key={field}>{missingFieldLabels[field] ?? "More details about your plans"}</li>)}</ul></>}
      {view.handoff && <p>Your saved review request is separate from CRM submission and does not unlock booking.</p>}
      <div className="callout-actions"><button type="button" className="btn btn-secondary btn-sm" onClick={back}>Continue conversation<Icon name="arrowRight" /></button></div>
    </Notice>}
    <div className="flow-actions">{allowHandoff && !isHandoff && <button type="button" className="btn btn-secondary" onClick={() => { setKind("handoff"); setErrors({}); }}>Request human review</button>}{isHandoff && <button type="button" className="btn btn-secondary" onClick={() => { setKind("contact"); setErrors({}); }}>Return to booking steps</button>}</div>
  </>;
}
