export const TIME_ZONE_LABEL = "Asia/Ho_Chi_Minh (GMT+7)";
const date = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", weekday: "long", day: "numeric", month: "long", year: "numeric" });
const time = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", hour: "2-digit", minute: "2-digit", hour12: false });
const dateTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Ho_Chi_Minh", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
export function formatDate(iso: string): string { return date.format(new Date(iso)); }
export function formatTime(iso: string): string { return time.format(new Date(iso)); }
export function formatDateTime(iso: string): string { return dateTime.format(new Date(iso)); }
export function formatVnd(value: number): string { return `VND ${value.toLocaleString("en-US")}`; }
