import { describe, expect, it } from "vitest";
import { computeSlots } from "../../src/domain/booking-slots";
import { DEFAULT_POLICY } from "../../src/domain/policy";
const now = new Date("2026-11-09T02:00:00Z"); // Monday 09:00 Vietnam
const input = { now, busy: [], policy: DEFAULT_POLICY };
const starts = () => computeSlots(input).map(slot => slot.startUtc);
describe("Vietnam appointment boundaries", () => {
  it("includes exactly 24 hours but excludes any earlier start and the day-14 horizon", () => {
    const values = starts();
    expect(values[0]).toBe("2026-11-10T02:00:00.000Z");
    expect(values).not.toContain("2026-11-10T01:30:00.000Z");
    expect(values).not.toContain("2026-11-23T02:00:00.000Z");
    expect(values.every(value => Date.parse(value) >= now.getTime()+86_400_000 && Date.parse(value) < now.getTime()+14*86_400_000)).toBe(true);
  });
  it("allows an appointment ending at noon or 17:00, never one beginning then", () => {
    const values = starts();
    expect(values).toContain("2026-11-10T04:30:00.000Z");
    expect(values).not.toContain("2026-11-10T05:00:00.000Z");
    expect(values).toContain("2026-11-10T09:30:00.000Z");
    expect(values).not.toContain("2026-11-10T10:00:00.000Z");
  });
  it("excludes weekends without accidentally excluding Monday", () => {
    const values = starts();
    expect(values).not.toContain("2026-11-14T02:00:00.000Z");
    expect(values).not.toContain("2026-11-15T02:00:00.000Z");
    expect(values).toContain("2026-11-16T02:00:00.000Z");
  });
  it("uses end-exclusive busy intervals and blocks partial overlap", () => {
    const slots=computeSlots({...input,busy:[{startUtc:"2026-11-10T01:30:00Z",endUtc:"2026-11-10T02:00:00Z"},{startUtc:"2026-11-10T02:45:00Z",endUtc:"2026-11-10T03:15:00Z"}]}).map(s=>s.startUtc);
    expect(slots).toContain("2026-11-10T02:00:00.000Z");
    expect(slots).not.toContain("2026-11-10T02:30:00.000Z");
    expect(slots).not.toContain("2026-11-10T03:00:00.000Z");
    expect(slots).toContain("2026-11-10T03:30:00.000Z");
  });
  it("does not turn missing or malformed busy information into availability", () => {
    expect(()=>computeSlots({...input,busy:undefined as never})).toThrow();
    expect(()=>computeSlots({...input,busy:[{startUtc:"bad",endUtc:"2026-11-10T03:00:00Z"}]})).toThrow();
    expect(()=>computeSlots({...input,busy:[{startUtc:"2026-11-10T03:00:00Z",endUtc:"2026-11-10T02:00:00Z"}]})).toThrow();
  });
  it("returns the actual 30-minute UTC interval with explicit agency timezone", () => {
    expect(computeSlots(input)[0]).toEqual({startUtc:"2026-11-10T02:00:00.000Z",endUtc:"2026-11-10T02:30:00.000Z",timeZone:"Asia/Ho_Chi_Minh"});
  });
});
