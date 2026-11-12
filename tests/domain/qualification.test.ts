import { describe, expect, it } from "vitest";
import { leadFactsSchema, qualify } from "../../src/domain/qualification";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import type { LeadFacts } from "../../src/domain/types";
const today = "2026-11-11";
const good: LeadFacts = { service: "meta_ads", business: "Cửa hàng thử nghiệm", hasWebsite: true, budget: { kind: "total", totalMonthlyVnd: 15_000_000 }, startDate: "2026-12-01" };
const status = (patch: Partial<LeadFacts>) => qualify({ ...good, ...patch }, DEFAULT_POLICY, today).status;
describe("qualification gates", () => {
 it("qualifies a fully specified Meta budget but not Google's higher minimum", () => { expect(status({})).toBe("qualified"); expect(status({service:"google_ads"})).toBe("not_qualified"); });
 it("asks for the budget basis and management fee consent rather than inferring them", () => { expect(status({budget:{kind:"unknown"}})).toBe("needs_info"); expect(status({budget:{kind:"media_only",mediaMonthlyVnd:10_000_000,acceptsManagementFee:null}})).toBe("needs_info"); expect(status({budget:{kind:"media_only",mediaMonthlyVnd:10_000_000,acceptsManagementFee:true}})).toBe("qualified"); expect(status({budget:{kind:"media_only",mediaMonthlyVnd:10_000_000,acceptsManagementFee:false}})).toBe("not_qualified"); });
 it("requires a Google website and complete business facts", () => { expect(status({service:"google_ads",hasWebsite:null})).toBe("needs_info"); expect(status({business:null})).toBe("needs_info"); });
 it("includes day 90 and excludes day 91 or a past date", () => { expect(status({startDate:"2027-02-09"})).toBe("qualified"); expect(status({startDate:"2027-02-10"})).toBe("not_qualified"); expect(status({startDate:"2026-11-10"})).toBe("not_qualified"); });
 it("routes explicitly out-of-scope needs to review without qualifying", () => { expect(status({requiresManualReview:true})).toBe("manual_review"); expect(status({service:null})).toBe("needs_info"); });
 it.each([-1, NaN, Infinity, 1.5])("rejects malformed money %s", amount => { expect(() => status({budget:{kind:"total",totalMonthlyVnd:amount}})).toThrow(); });
 it.each(["2026-02-30", "2026-13-01", "tomorrow"])("rejects invalid date %s", startDate => { expect(() => status({startDate})).toThrow(); });
 it("does not let ample media compensate for insufficient management fee", () => { expect(status({budget:{kind:"split",mediaMonthlyVnd:50_000_000,managementMonthlyVnd:4_000_000}})).toBe("not_qualified"); });
});

describe("combined Meta and Google Ads", () => {
 const combined = (patch: Record<string, unknown> = {}, policy = DEFAULT_POLICY) =>
  qualify(leadFactsSchema.parse({ ...good, service: "both_ads", budget: { kind: "total", totalMonthlyVnd: 36_000_000 }, ...patch }), policy, today);

 it("qualifies the combined total minimum, not either single-service minimum", () => {
  expect(combined().status).toBe("qualified");
  expect(combined({ budget: { kind: "total", totalMonthlyVnd: 35_999_999 } }).status).toBe("not_qualified");
  expect(combined({ budget: { kind: "total", totalMonthlyVnd: 21_000_000 } }).status).toBe("not_qualified");
 });
 it("requires the Google website for a combined request", () => {
  expect(combined({ hasWebsite: null })).toMatchObject({ status: "needs_info", missing: ["hasWebsite"] });
  expect(combined({ hasWebsite: false }).status).toBe("not_qualified");
 });
 it("requires separate fee acceptance for a combined media-only budget", () => {
  expect(combined({ budget: { kind: "media_only", mediaMonthlyVnd: 25_000_000, acceptsManagementFee: null } })).toMatchObject({ status: "needs_info", missing: ["acceptsManagementFee"] });
  expect(combined({ budget: { kind: "media_only", mediaMonthlyVnd: 25_000_000, acceptsManagementFee: false } }).status).toBe("not_qualified");
  expect(combined({ budget: { kind: "media_only", mediaMonthlyVnd: 25_000_000, acceptsManagementFee: true } }).status).toBe("qualified");
  expect(combined({ budget: { kind: "media_only", mediaMonthlyVnd: 24_999_999, acceptsManagementFee: true } }).status).toBe("not_qualified");
 });
 it("requires both split components independently", () => {
  expect(combined({ budget: { kind: "split", mediaMonthlyVnd: 25_000_000, managementMonthlyVnd: 11_000_000 } }).status).toBe("qualified");
  expect(combined({ budget: { kind: "split", mediaMonthlyVnd: 50_000_000, managementMonthlyVnd: 10_999_999 } }).status).toBe("not_qualified");
  expect(combined({ budget: { kind: "split", mediaMonthlyVnd: 24_999_999, managementMonthlyVnd: 50_000_000 } }).status).toBe("not_qualified");
 });
 it("uses active policy prices rather than a hard-coded combined package", () => {
  const policy = structuredClone(DEFAULT_POLICY);
  policy.services.meta_ads.managementMonthlyVnd = 7_000_000;
  policy.services.google_ads.minimumMediaMonthlyVnd = 18_000_000;
  expect(combined({ budget: { kind: "total", totalMonthlyVnd: 40_999_999 } }, policy).status).toBe("not_qualified");
  expect(combined({ budget: { kind: "total", totalMonthlyVnd: 41_000_000 } }, policy).status).toBe("qualified");
 });
 it("does not retain combined requirements after an explicit single-service correction", () => {
  expect(combined({ service: "meta_ads", hasWebsite: false, budget: { kind: "total", totalMonthlyVnd: 15_000_000 } }).status).toBe("qualified");
  expect(combined({ service: "google_ads", budget: { kind: "total", totalMonthlyVnd: 21_000_000 } }).status).toBe("qualified");
 });
});
