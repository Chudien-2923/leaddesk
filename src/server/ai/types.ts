import "server-only";
import { Buffer } from "node:buffer";
import { leadFactsSchema } from "../../domain/qualification";
import type { LeadFacts } from "../../domain/types";

export const PRIMARY_MODEL = "google-antigravity/gemini-3.8-flash" as const;
export const FALLBACK_MODEL = "openai-codex/gpt-5.6-luna" as const;
export const MODEL_SELECTORS = [PRIMARY_MODEL, FALLBACK_MODEL] as const;
export type ModelSelector = (typeof MODEL_SELECTORS)[number];
export interface ModelInput {
  purpose: "extract" | "answer";
  messages: { role: "system" | "user" | "assistant"; content: string }[];
}
export type ModelErrorCode =
  | "auth" | "permission" | "configuration" | "refusal" | "invalid_extraction"
  | "model_mismatch" | "protocol" | "output_limit" | "child_exit" | "aborted"
  | "upstream" | "rate_limited" | "network" | "attempt_timeout" | "unavailable"
  | "input_limit" | "invalid_answer";
export interface ModelTrace {
  requestedModel: ModelSelector;
  reportedModel?: string;
  outcome: ModelErrorCode | "success";
}
export interface ModelResult {
  text: string;
  requestedModel: ModelSelector;
  reportedModel: string;
  fallbackUsed: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
  trace?: ModelTrace[];
}
export class ModelError extends Error {
  readonly code: ModelErrorCode;
  readonly status?: number;
  readonly trace: ModelTrace[];
  readonly reportedModel?: string;

  constructor(code: ModelErrorCode, message: string, options: {
    status?: number; trace?: ModelTrace[]; reportedModel?: string; cause?: unknown;
  } = {}) {
    super(message, { cause: options.cause });
    this.name = "ModelError";
    this.code = code;
    this.status = options.status;
    this.trace = options.trace ?? [];
    this.reportedModel = options.reportedModel;
  }
}
export type ModelInvoker = (model: ModelSelector, input: ModelInput, signal: AbortSignal) => Promise<ModelResult>;
export type ModelCaller = (input: ModelInput, signal: AbortSignal) => Promise<ModelResult>;
export const MAX_APPROXIMATE_INPUT_TOKENS = 6_000;

/** Approximation only: UTF-8 bytes / 3, not a Gemini or Codex tokenizer. */
export function estimateInputTokens(input: ModelInput): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(input.messages), "utf8") / 3);
}
export function validateModelInput(input: ModelInput): void {
  if (!input || !["extract", "answer"].includes(input.purpose)
    || !Array.isArray(input.messages) || input.messages.length === 0
    || input.messages.some((message) => !message || !["system", "user", "assistant"].includes(message.role)
      || typeof message.content !== "string")) {
    throw new ModelError("protocol", "Invalid model input messages");
  }
  if (estimateInputTokens(input) > MAX_APPROXIMATE_INPUT_TOKENS) {
    throw new ModelError("input_limit", "Input exceeds the approximate 6,000-token budget (UTF-8 bytes / 3)");
  }
}
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ModelError("aborted", "Model request cancelled");
}
export function matchesSelectedModel(selected: ModelSelector, reported: unknown): reported is string {
  return typeof reported === "string" && (reported === selected || reported === selected.slice(selected.indexOf("/") + 1));
}

/** Omitted keys retain existing facts; explicit null represents an unknown fact. */
export const leadFactsUpdateSchema = leadFactsSchema.partial();
export function parseExtractedFacts(text: string): Partial<LeadFacts> {
  try {
    return leadFactsUpdateSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new ModelError("invalid_extraction", "Model extraction is not valid lead-facts JSON", { cause });
  }
}
