import type { ReactNode } from "react";
import type { PublicChatView } from "@/server/conversation/public-view";
import type { LeadFacts, Slot } from "@/domain/types";
import { formatDate, formatTime, formatVnd, TIME_ZONE_LABEL } from "@/client/format";
import { SERVICE_TITLES } from "@/domain/policy";
import { Icon } from "@/components/ui/Icon";
import { Notice } from "@/components/ui/Notice";

export function FactList({ facts }: { facts?: LeadFacts }) {
  let budget: ReactNode = null;
  if (facts) {
    switch (facts.budget.kind) {
      case "total": budget = <>{formatVnd(facts.budget.totalMonthlyVnd)}<span className="sub">Total monthly budget</span></>; break;
      case "media_only": budget = <>{formatVnd(facts.budget.mediaMonthlyVnd)}<span className="sub">Ad spend only · Management fee {facts.budget.acceptsManagementFee === null ? "not confirmed" : facts.budget.acceptsManagementFee ? "accepted" : "not accepted"}</span></>; break;
      case "split": budget = <>{formatVnd(facts.budget.mediaMonthlyVnd)} ad spend<span className="sub">{formatVnd(facts.budget.managementMonthlyVnd)} management</span></>; break;
    }
  }
  const rows: [string, ReactNode][] = [
    ["Service", facts?.service ? SERVICE_TITLES[facts.service] : null],
    ["Business", facts?.business], ["Monthly budget", budget], ["Intended start", facts?.startDate],
    ["Website", facts?.hasWebsite == null ? null : facts.hasWebsite ? "Yes" : "Not yet"],
  ];
  return <dl className="dl">{rows.map(([label, value]) => <div className="dl-row" key={label}><dt>{label}</dt><dd className={value == null ? "is-missing" : undefined}>{value ?? "Not shared yet"}</dd></div>)}</dl>;
}
export function AppointmentDetails({ slot }: { slot: Slot }) {
  const minutes = Math.round((Date.parse(slot.endUtc) - Date.parse(slot.startUtc)) / 60000);
  return <dl className="dl"><div className="dl-row"><dt>Date</dt><dd>{formatDate(slot.startUtc)}</dd></div><div className="dl-row"><dt>Time</dt><dd>{formatTime(slot.startUtc)}–{formatTime(slot.endUtc)}</dd></div><div className="dl-row"><dt>Timezone</dt><dd>{TIME_ZONE_LABEL}</dd></div><div className="dl-row"><dt>Duration</dt><dd>{minutes} minutes</dd></div></dl>;
}
export function OperationStatus({ view, refresh, busy }: { view: PublicChatView; refresh: () => void; busy: boolean }) {
  return <>
    {view.crm.status !== "none" && <Notice tone={view.crm.status === "saved" ? "ok" : view.crm.status === "failed" ? "danger" : "warn"} title={view.crm.status === "saved" ? "Contact and consultation note saved" : view.crm.status === "partial" ? "Partly saved — booking remains locked" : view.crm.status === "unknown" ? "CRM outcome is not confirmed" : "CRM save failed"}>
      {view.crm.status !== "saved" && <p>{view.crm.status === "partial" ? "The Contact and Note are not both confirmed. " : ""}Refresh reads the saved status only. The agency administrator must review this operation before a new submission; do not submit another copy.</p>}
      {view.crm.operationId && <p className="ref">CRM operation <span className="mono">{view.crm.operationId}</span></p>}
    </Notice>}
    {view.booking && <Notice tone={view.booking.status === "booked" ? "ok" : view.booking.status === "failed" ? "danger" : "warn"} title={view.booking.status === "booked" ? "Your consultation is booked" : `Booking: ${view.booking.status}`}>
      {view.booking.slot && <AppointmentDetails slot={view.booking.slot} />}
      {view.booking.status === "booked" ? <><p>This is saved on the agency calendar. No email or calendar invitation is sent by this page.</p><p>CRM note synchronization: {view.booking.crmSyncStatus ?? "not reported"}. A synchronization issue does not cancel your booking. Please contact the agency for changes.</p></> : <p>{["unknown", "pending"].includes(view.booking.status) ? "The calendar result is not confirmed. Do not make a second booking. Refresh reads the current status; the agency administrator must reconcile the original operation if it remains unresolved." : "No confirmed booking is shown. Review the current permitted next step below before trying again."}</p>}
      {view.booking.operationId && <p className="ref">Booking operation <span className="mono">{view.booking.operationId}</span></p>}
      {view.booking.eventId && <p className="ref">Calendar event <span className="mono">{view.booking.eventId}</span></p>}
    </Notice>}
    {view.handoff && <Notice tone="ok" title="Your review request is saved"><p>The agency can review your request in its inbox. This does not book a consultation or mean someone has already read it.</p><p className="ref">Request <span className="mono">{view.handoff.handoffId}</span></p></Notice>}
    {(view.crm.status !== "none" || view.booking || view.handoff) && <button type="button" className="btn btn-secondary btn-sm" onClick={refresh} disabled={busy}><Icon name="refresh" />Refresh saved status</button>}
  </>;
}
export default function ConsultationSummary({ view, next, privacy }: {
  view: PublicChatView | null; next: () => void; privacy: () => void;
}) {
  const status = view?.qualification.status;
  const label = !view?.messages.length ? "Let’s get started" : view.factsValidationPending ? "Checking your latest information" : status === "qualified" ? "Ready for next steps" : status === "manual_review" ? "Needs human review" : status === "not_qualified" ? "Not a fit for booking yet" : "Getting to know your plans";
  return <div className="panel"><h2 className="panel-title">Your consultation</h2><div className="panel-status"><span className={`status is-${status === "qualified" && !view?.factsValidationPending ? "ok" : "neutral"}`}>{label}</span><p>{!view?.messages.length ? "As we talk, your plans and next steps will appear here." : "Next steps are based on the agency’s published requirements and the information you share."}</p>{view && <button type="button" className="btn btn-secondary btn-sm" onClick={next}>View next steps<Icon name="arrowRight" /></button>}</div><div className="panel-section"><h3 className="panel-h">What you’ve told us</h3><FactList facts={view?.facts} /></div>{view?.selectedSlot && <div className="panel-section"><h3 className="panel-h">Selected — not booked yet</h3><AppointmentDetails slot={view.selectedSlot} /></div>}{view?.booking && <div className="panel-section"><h3 className="panel-h">Appointment: {view.booking.status}</h3>{view.booking.slot && <AppointmentDetails slot={view.booking.slot} />}</div>}<div className="panel-section"><h3 className="panel-h">About consultations</h3><ul className="panel-list"><li><Icon name="clock" /><span>30-minute consultations</span></li><li><Icon name="globe" /><span>Times in {TIME_ZONE_LABEL}</span></li><li><Icon name="shield" /><span>Contact details are only saved with your consent</span></li></ul></div><p className="panel-foot"><button type="button" className="link-btn" onClick={privacy}>How we handle your data</button></p></div>;
}
