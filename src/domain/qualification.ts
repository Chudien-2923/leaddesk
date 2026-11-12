import { z } from "zod";
import type { LeadFacts, Qualification } from "./types";
import { agencyPolicySchema, policyForService, type AgencyPolicy } from "./policy";
export const localDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => { const d = new Date(v+"T00:00:00Z"); return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === v; }, "Invalid calendar date");
const money = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const leadFactsSchema = z.object({service:z.enum(["meta_ads","google_ads","both_ads"]).nullable(),business:z.string().trim().min(1).max(1000).nullable(),hasWebsite:z.boolean().nullable(),budget:z.discriminatedUnion("kind",[z.object({kind:z.literal("unknown")}).strict(),z.object({kind:z.literal("total"),totalMonthlyVnd:money}).strict(),z.object({kind:z.literal("media_only"),mediaMonthlyVnd:money,acceptsManagementFee:z.boolean().nullable()}).strict(),z.object({kind:z.literal("split"),mediaMonthlyVnd:money,managementMonthlyVnd:money}).strict()]),startDate:localDateSchema.nullable(),requiresManualReview:z.boolean().optional(),hasConflictingFacts:z.boolean().optional()}).strict();
export const EMPTY_FACTS: LeadFacts = {service:null,business:null,hasWebsite:null,budget:{kind:"unknown"},startDate:null};
export function qualify(input: LeadFacts, inputPolicy: AgencyPolicy, todayLocal: string): Qualification {
 const facts = leadFactsSchema.parse(input); const policy = agencyPolicySchema.parse(inputPolicy); const today = localDateSchema.parse(todayLocal);
 if(facts.requiresManualReview) return {status:"manual_review",missing:[],reasons:["Nhu cầu cần người thật xem xét"]};
 const missing: string[] = []; const reasons: string[] = [];
 if(facts.hasConflictingFacts) missing.push("conflicting_facts");
 if(!facts.service) missing.push("service"); if(!facts.business) missing.push("business"); if(!facts.startDate) missing.push("startDate");
 const service = facts.service ? policyForService(policy, facts.service) : null;
 if(service?.requiresWebsite && facts.hasWebsite === null) missing.push("hasWebsite");
 if(facts.budget.kind === "unknown") missing.push("budget");
 if(facts.budget.kind === "media_only" && facts.budget.acceptsManagementFee === null) missing.push("acceptsManagementFee");
 if(missing.length) return {status:"needs_info",missing,reasons:[]};
 if(!service) throw new Error("Missing service");
 if(service.requiresWebsite && facts.hasWebsite === false) reasons.push("Cần có website");
 const budget = facts.budget;
 if(budget.kind === "total" && budget.totalMonthlyVnd < service.managementMonthlyVnd+service.minimumMediaMonthlyVnd) reasons.push("Tổng ngân sách chưa đạt mức tối thiểu");
 if(budget.kind === "media_only" && (!budget.acceptsManagementFee || budget.mediaMonthlyVnd < service.minimumMediaMonthlyVnd)) reasons.push("Ngân sách media hoặc phí quản lý chưa đáp ứng");
 if(budget.kind === "split" && (budget.mediaMonthlyVnd < service.minimumMediaMonthlyVnd || budget.managementMonthlyVnd < service.managementMonthlyVnd)) reasons.push("Cần đáp ứng riêng phí quản lý và media");
 const days = (Date.parse(facts.startDate+"T00:00:00Z")-Date.parse(today+"T00:00:00Z"))/86_400_000;
 if(days < 0 || days > policy.timelineDays) reasons.push("Thời điểm bắt đầu ngoài phạm vi");
 return {status:reasons.length ? "not_qualified":"qualified",missing:[],reasons};
}
