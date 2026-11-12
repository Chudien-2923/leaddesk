export type ServiceId = "meta_ads" | "google_ads" | "both_ads";
export type Classification = "needs_info" | "qualified" | "not_qualified" | "manual_review";
export type WriteStatus = "pending" | "succeeded" | "failed" | "unknown";
export type Budget = { kind: "unknown" } | { kind: "total"; totalMonthlyVnd: number } | { kind: "media_only"; mediaMonthlyVnd: number; acceptsManagementFee: boolean | null } | { kind: "split"; mediaMonthlyVnd: number; managementMonthlyVnd: number };
export interface LeadFacts { service: ServiceId | null; business: string | null; hasWebsite: boolean | null; budget: Budget; startDate: string | null; requiresManualReview?: boolean; hasConflictingFacts?: boolean }
export interface Qualification { status: Classification; missing: string[]; reasons: string[] }
export interface Contact { name: string; email: string; phone?: string }
export interface Slot { startUtc: string; endUtc: string; timeZone: "Asia/Ho_Chi_Minh" }
export interface BusyInterval { startUtc: string; endUtc: string }
export interface Citation { chunkId: string; documentId: string; releaseId: string; title: string; excerpt: string }
