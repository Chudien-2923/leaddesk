import { describe, expect, it } from "vitest";
import { createModelRouter } from "../../src/server/ai/model-router";
import { ModelError, type ModelInput, type ModelResult, type ModelSelector } from "../../src/server/ai/types";

const GEMINI: ModelSelector = "google-antigravity/gemini-3.8-flash";
const LUNA: ModelSelector = "openai-codex/gpt-5.6-luna";
const input: ModelInput = {
  purpose: "answer",
  messages: [{ role: "user", content: "Dịch vụ mẫu nào phù hợp với cửa hàng thử nghiệm?" }],
};
const result = (model: ModelSelector, text: string): ModelResult => ({
  text, requestedModel: model, reportedModel: model, fallbackUsed: false,
  usage: { inputTokens: 23, outputTokens: 11 },
});
type Invoke = (model: ModelSelector, input: ModelInput, signal: AbortSignal) => Promise<ModelResult>;
type Step = ModelResult | Error | ((signal: AbortSignal) => Promise<ModelResult>);

// Only the external provider boundary is scripted; routing, provenance and failure
// aggregation are real. An extra retry cannot obtain another successful response.
function transport(steps: Step[]) {
  const calls: ModelSelector[] = [];
  const invoke: Invoke = async (model, _input, signal) => {
    calls.push(model);
    const step = steps[calls.length - 1];
    if (!step) throw new Error("Unexpected third provider attempt");
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(signal) : step;
  };
  return { calls, route: createModelRouter(invoke) };
}

async function failure(operation: Promise<unknown>): Promise<ModelError> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected a typed model failure, not an answer");
}

describe("explicit Gemini → Luna routing", () => {
  it("publishes a validated primary result with primary provenance and no fallback", async () => {
    const { route, calls } = transport([result(GEMINI, "Cần xác định ngân sách trước khi tư vấn.")]);
    const answer = await route(input, new AbortController().signal);
    expect(answer).toMatchObject({
      text: "Cần xác định ngân sách trước khi tư vấn.", requestedModel: GEMINI,
      reportedModel: GEMINI, fallbackUsed: false,
      usage: { inputTokens: 23, outputTokens: 11 },
      trace: [{ requestedModel: GEMINI, reportedModel: GEMINI, outcome: "success" }],
    });
    expect(calls).toEqual([GEMINI]);
  });

  it.each([
    ["upstream", 503], ["rate_limited", 429], ["network", undefined], ["attempt_timeout", undefined],
  ] as const)("falls back exactly once for %s, retaining the failed primary trace", async (code, status) => {
    const { route, calls } = transport([
      new ModelError(code, "Synthetic provider failure", { status }),
      result(LUNA, "Hãy cung cấp loại dịch vụ và ngân sách dự kiến."),
    ]);
    const answer = await route(input, new AbortController().signal);
    expect(answer).toMatchObject({
      text: "Hãy cung cấp loại dịch vụ và ngân sách dự kiến.", requestedModel: LUNA,
      reportedModel: LUNA, fallbackUsed: true,
      trace: [
        { requestedModel: GEMINI, outcome: code },
        { requestedModel: LUNA, reportedModel: LUNA, outcome: "success" },
      ],
    });
    expect(calls).toEqual([GEMINI, LUNA]);
  });

  it("returns typed unavailability without an answer or a third attempt when both sources fail", async () => {
    const { route, calls } = transport([
      new ModelError("upstream", "Primary unavailable", { status: 503 }),
      new ModelError("rate_limited", "Fallback quota exhausted", { status: 429 }),
    ]);
    const error = await failure(route(input, new AbortController().signal));
    expect(error.code).toBe("unavailable");
    expect(error.trace).toEqual([
      { requestedModel: GEMINI, outcome: "upstream" },
      { requestedModel: LUNA, outcome: "rate_limited" },
    ]);
    expect(error).not.toHaveProperty("text");
    expect(calls).toEqual([GEMINI, LUNA]);
  });

  it.each([
    "auth", "permission", "configuration", "refusal", "invalid_extraction",
    "model_mismatch", "protocol", "output_limit", "child_exit", "aborted",
  ] as const)("does not hide %s by switching providers", async (code) => {
    const { route, calls } = transport([new ModelError(code, "Synthetic terminal failure")]);
    const error = await failure(route({ ...input, purpose: code === "invalid_extraction" ? "extract" : "answer" }, new AbortController().signal));
    expect(error.code).toBe(code);
    expect(error.trace).toEqual([{ requestedModel: GEMINI, outcome: code }]);
    expect(error).not.toHaveProperty("text");
    expect(calls).toEqual([GEMINI]);
  });

  it("rejects foreign reported provenance even when the transport resolves successfully", async () => {
    const { route, calls } = transport([{ ...result(GEMINI, "Untrusted answer"), reportedModel: LUNA }]);
    const error = await failure(route(input, new AbortController().signal));
    expect(error.code).toBe("model_mismatch");
    expect(error.trace).toEqual([{ requestedModel: GEMINI, reportedModel: LUNA, outcome: "model_mismatch" }]);
    expect(error).not.toHaveProperty("text");
    expect(calls).toEqual([GEMINI]);
  });

  it("does not attempt either provider after a caller has already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { route, calls } = transport([]);
    const error = await failure(route(input, controller.signal));
    expect(error.code).toBe("aborted");
    expect(error.trace).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("treats caller cancellation during primary as cancellation, not an attempt timeout eligible for fallback", async () => {
    const controller = new AbortController();
    const { route, calls } = transport([async () => {
      controller.abort();
      throw new ModelError("attempt_timeout", "Attempt ended concurrently with caller cancellation");
    }]);
    const error = await failure(route(input, controller.signal));
    expect(error.code).toBe("aborted");
    expect(error.trace).toEqual([{ requestedModel: GEMINI, outcome: "aborted" }]);
    expect(calls).toEqual([GEMINI]);
  });

  it("cancels an in-flight fallback without retrying or publishing its late answer", async () => {
    const controller = new AbortController();
    const { route, calls } = transport([
      new ModelError("upstream", "Primary unavailable", { status: 503 }),
      async () => {
        controller.abort();
        return result(LUNA, "Late answer must not be published");
      },
    ]);
    const error = await failure(route(input, controller.signal));
    expect(error.code).toBe("aborted");
    expect(error.trace).toEqual([
      { requestedModel: GEMINI, outcome: "upstream" },
      { requestedModel: LUNA, outcome: "aborted" },
    ]);
    expect(error).not.toHaveProperty("text");
    expect(calls).toEqual([GEMINI, LUNA]);
  });
});
