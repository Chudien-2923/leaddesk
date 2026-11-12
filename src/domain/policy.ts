import { z } from "zod";
import type { ServiceId } from "./types";
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const service = z.object({ title: z.string().min(1), managementMonthlyVnd: money, minimumMediaMonthlyVnd: money, requiresWebsite: z.boolean() }).strict();
export const agencyPolicySchema = z.object({ version: z.string().min(1).max(128), services: z.object({meta_ads:service, google_ads:service}).strict(), timelineDays: z.literal(90), booking: z.object({timeZone:z.literal("Asia/Ho_Chi_Minh"),durationMinutes:z.literal(30),gridMinutes:z.literal(30),leadHours:z.literal(24),horizonDays:z.literal(14),weekdays:z.array(z.number().int().min(1).max(5)).length(5),workingBlocks:z.array(z.tuple([z.string().regex(/^\d{2}:\d{2}$/),z.string().regex(/^\d{2}:\d{2}$/)])).length(2)}).strict() }).strict();
export type AgencyPolicy = z.infer<typeof agencyPolicySchema>;
export const DEFAULT_POLICY: AgencyPolicy = { version:"leaddesk-en-2026-11-12", services:{meta_ads:{title:"Meta Ads management",managementMonthlyVnd:5_000_000,minimumMediaMonthlyVnd:10_000_000,requiresWebsite:false},google_ads:{title:"Google Ads management",managementMonthlyVnd:6_000_000,minimumMediaMonthlyVnd:15_000_000,requiresWebsite:true}},timelineDays:90,booking:{timeZone:"Asia/Ho_Chi_Minh",durationMinutes:30,gridMinutes:30,leadHours:24,horizonDays:14,weekdays:[1,2,3,4,5],workingBlocks:[["09:00","12:00"],["13:00","17:00"]]}};
export function agencyToday(now = new Date()): string { return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Ho_Chi_Minh",year:"numeric",month:"2-digit",day:"2-digit"}).format(now); }

export const SERVICE_TITLES: Record<ServiceId, string> = {
  meta_ads: "Meta Ads management",
  google_ads: "Google Ads management",
  both_ads: "Meta Ads and Google Ads management",
};

/** Resolve a visitor's selection from the two published base policies. */
export function policyForService(policy: AgencyPolicy, selection: ServiceId): AgencyPolicy["services"]["meta_ads"] {
  if (selection !== "both_ads") return policy.services[selection];
  const meta = policy.services.meta_ads;
  const google = policy.services.google_ads;
  const managementMonthlyVnd = meta.managementMonthlyVnd + google.managementMonthlyVnd;
  const minimumMediaMonthlyVnd = meta.minimumMediaMonthlyVnd + google.minimumMediaMonthlyVnd;
  if (!Number.isSafeInteger(managementMonthlyVnd) || !Number.isSafeInteger(minimumMediaMonthlyVnd)
    || !Number.isSafeInteger(managementMonthlyVnd + minimumMediaMonthlyVnd)) {
    throw new Error("Combined service price exceeds the safe integer range");
  }
  return {
    title: `${meta.title} + ${google.title}`,
    managementMonthlyVnd,
    minimumMediaMonthlyVnd,
    requiresWebsite: meta.requiresWebsite || google.requiresWebsite,
  };
}

/** Price evidence is generated from the policy snapshot, never copied from an older release. */
export function renderPricingPolicy(input: AgencyPolicy): string {
  const policy = agencyPolicySchema.parse(input);
  const money = new Intl.NumberFormat("en-US");
  const services = Object.entries(policy.services).map(([id, service]) =>
    `${id === "meta_ads" ? "Meta Ads / Facebook Ads" : "Google Ads"}: management fee VND ${money.format(service.managementMonthlyVnd)} per month; minimum media spend VND ${money.format(service.minimumMediaMonthlyVnd)} per month paid to the advertising platform, excluding the management fee. Minimum combined monthly budget VND ${money.format(service.managementMonthlyVnd + service.minimumMediaMonthlyVnd)}. ${service.requiresWebsite ? "A website is required." : "A website is not required."} We do not guarantee ROAS, revenue or order volume.`);
  const booking = policy.booking;
  return [
    `# Pricing and consultation requirements — ${policy.version}`,
    "The management fee and advertising media spend are separate amounts. Prices are in Vietnamese dong (VND).",
    ...services,
    `A media-only budget requires explicit acceptance of the separate management fee. A combined budget must cover both amounts. An initial assessment needs the service, business, budget basis and intended start date within ${policy.timelineDays} days. Ask for missing or conflicting information; do not assume eligibility.`,
    `Consultations last ${booking.durationMinutes} minutes in ${booking.timeZone}, Monday to Friday, ${booking.workingBlocks.map(block => block.join("–")).join(" and ")}. Times follow a ${booking.gridMinutes}-minute grid, with at least ${booking.leadHours} hours’ notice and a ${booking.horizonDays}-day booking horizon. Contact and a consultation note must be saved with consent before offering times. Only explicit final confirmation can create a booking, after checking availability. No emails, calendar invitations or meeting links are sent.`,
  ].join("\n\n") + "\n";
}
