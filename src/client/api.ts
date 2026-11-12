const messages: Record<string, string> = {
  ADMIN_UNAUTHORIZED: "Sign in with an authorized administrator account to continue.",
  AUTH_FAILED: "We couldn’t sign you in. Check your credentials and try again.",
  AUTH_NOT_CONFIGURED: "Administrator sign-in is not connected yet.",
  CONVERSATION_UNAUTHORIZED: "Your consultation session is no longer available. Start a new consultation.",
  CONVERSATION_FORBIDDEN: "This consultation is not available to your session.",
  CONVERSATION_NOT_FOUND: "This consultation is no longer available.",
  CONVERSATION_BUSY: "Your previous request is still processing. Check its status before continuing.",
  KNOWLEDGE_NOT_READY: "Published service information is not ready yet. Please try again later.",
  EMBEDDING_NOT_READY: "Service information cannot be searched right now. Please try again later.",
  INVALID_REQUEST: "Please check the information you entered and try again.",
  RATE_LIMITED: "You’ve reached the consultation limit. Please try again later.",
  ORIGIN_FORBIDDEN: "Open LeadDesk on its local address to continue.",
  REQUEST_TOO_LARGE: "This request is too large. Shorten your text and try again.",
  POLICY_VERSION_CONFLICT: "This policy revision was already published with different values. Use a new revision.",
  DRAFT_REQUEST_CONFLICT: "This draft request already exists with different contents. Check its saved version before making another change.",
  OPERATION_PAYLOAD_CONFLICT: "This operation has already started with different details. Check its status first.",
  BOOKING_STALE: "Your consultation details changed. Review the current information and choose a time again.",
  SLOT_UNAVAILABLE: "That time is no longer available. Choose another time and confirm again.",
  SOURCE_NOT_FOUND: "This source is no longer available to your consultation.",
  OPERATION_NOT_RECONCILABLE: "This operation cannot be reconciled here. Review its saved status.",
  NETWORK_ERROR: "The connection was interrupted. Check the current status before repeating an action.",
  SERVICE_UNAVAILABLE: "This service is unavailable or not connected. Your request has not been confirmed. Please try again later.",
};
export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number) { super(messages[code] ?? messages.SERVICE_UNAVAILABLE); this.name = "ApiError"; }
}
export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    const headers = new Headers(init?.headers);
    if (init?.body !== undefined) headers.set("Content-Type", "application/json");
    response = await fetch(url, { ...init, headers, credentials: "same-origin", cache: "no-store" });
  } catch { throw new ApiError("NETWORK_ERROR", 0); }
  let value: unknown;
  try { value = await response.json(); } catch { throw new ApiError("SERVICE_UNAVAILABLE", response.status); }
  if (!response.ok) {
    const code = typeof value === "object" && value !== null && "error" in value && typeof value.error === "object" && value.error !== null && "code" in value.error && typeof value.error.code === "string" ? value.error.code : "SERVICE_UNAVAILABLE";
    throw new ApiError(code, response.status);
  }
  return value as T;
}
