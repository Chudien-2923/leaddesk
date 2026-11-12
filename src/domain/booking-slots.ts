import { z } from "zod";
import { agencyPolicySchema, type AgencyPolicy } from "./policy";
import type { BusyInterval, Slot } from "./types";

const busySchema = z.array(z.object({
  startUtc: z.iso.datetime({ offset: true }),
  endUtc: z.iso.datetime({ offset: true }),
}).refine(value => Date.parse(value.endUtc) > Date.parse(value.startUtc), "Busy interval must have positive duration"));
const MINUTE = 60_000;
const DAY = 86_400_000;
// Asia/Ho_Chi_Minh has a fixed UTC+07 offset throughout the demo horizon.
const VIETNAM_OFFSET = 7 * 60 * MINUTE;

export function computeSlots(input: { now: Date; busy: BusyInterval[]; policy: AgencyPolicy }): Slot[] {
  const policy = agencyPolicySchema.parse(input.policy);
  const now = z.date().parse(input.now).getTime();
  const busy = busySchema.parse(input.busy).map(interval => ({ start: Date.parse(interval.startUtc), end: Date.parse(interval.endUtc) }));
  const earliest = now + policy.booking.leadHours * 60 * MINUTE;
  const horizon = now + policy.booking.horizonDays * DAY;
  const firstLocalDay = Math.floor((earliest + VIETNAM_OFFSET) / DAY) * DAY;
  const slots: Slot[] = [];
  for (let localDay = firstLocalDay; localDay - VIETNAM_OFFSET < horizon; localDay += DAY) {
    if (!policy.booking.weekdays.includes(new Date(localDay).getUTCDay())) continue;
    for (const [blockStart, blockEnd] of policy.booking.workingBlocks) {
      const [startHour, startMinute] = blockStart.split(":").map(Number);
      const [endHour, endMinute] = blockEnd.split(":").map(Number);
      const blockStartUtc = localDay - VIETNAM_OFFSET + (startHour * 60 + startMinute) * MINUTE;
      const blockEndUtc = localDay - VIETNAM_OFFSET + (endHour * 60 + endMinute) * MINUTE;
      for (let start = blockStartUtc; start + policy.booking.durationMinutes * MINUTE <= blockEndUtc; start += policy.booking.gridMinutes * MINUTE) {
        const end = start + policy.booking.durationMinutes * MINUTE;
        if (start < earliest || start >= horizon || busy.some(interval => interval.start < end && interval.end > start)) continue;
        slots.push({ startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), timeZone: policy.booking.timeZone });
      }
    }
  }
  return slots;
}
