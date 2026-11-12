import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createOmpInvoker } from "../../src/server/ai/omp-stdio";
import { ModelError, type ModelInput, type ModelSelector } from "../../src/server/ai/types";

const GEMINI: ModelSelector = "google-antigravity/gemini-3.8-flash";
const fixture = fileURLToPath(new URL("../fixtures/fault-gateway.mjs", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
const input: ModelInput = {
  purpose: "answer", messages: [{ role: "user", content: "Xin tư vấn ngân sách mẫu." }],
};
type ChildRecord = {
  pid: number;
  cwd: string;
  stdinClosed: boolean;
  requests: { id: number | string; path: string; body: { model: string; stream: boolean; messages: { role: string; content: string }[]; tools?: unknown } }[];
};
let directory: string;
let recordPath: string;
const ownedCwds = new Set<string>();

async function record(): Promise<ChildRecord> {
  return JSON.parse(await readFile(recordPath, "utf8")) as ChildRecord;
}
function isRunning(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}
// Platform integration deadlines: fake time cannot advance the independently
// running child's IO, SIGTERM handling, or process exit.
async function waitForRequest() {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    try {
      const child = await record();
      if (child.requests.length === 1 && child.stdinClosed) return child;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    const pause = Promise.withResolvers<void>();
    setTimeout(pause.resolve, 10);
    await pause.promise;
  }
  throw new Error("Fixture did not receive the JSONL request and stdin EOF");
}
function invokeFor(mode: string, deadlineMs = 2_000) {
  return createOmpInvoker({
    command: process.execPath,
    args: [fixture, mode, recordPath],
    deadlineMs,
    // Test-only seam: no real omp subprocess, account, credential or inference.
    configVerifier: async (cwd: string, signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
      ownedCwds.add(cwd);
    },
  });
}
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const deadline = Promise.withResolvers<never>();
    timer = setTimeout(() => deadline.reject(new Error("Invoker did not settle within 4 seconds")), 4_000);
    return await Promise.race([operation, deadline.promise]);
  } finally { clearTimeout(timer); }
}
async function failure(operation: Promise<unknown>) {
  try { await bounded(operation); } catch (error) {
    expect(error).toBeInstanceOf(ModelError);
    return error as ModelError;
  }
  throw new Error("Expected a typed protocol failure, not an answer");
}
async function assertReaped() {
  const child = await record();
  // Promise settlement is the ownership boundary: no grace-period polling here.
  expect(isRunning(child.pid)).toBe(false);
  expect(existsSync(child.cwd)).toBe(false);
  return child;
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "leaddesk-gateway-test-"));
  recordPath = join(directory, "child.json");
  ownedCwds.clear();
});
afterEach(async () => {
  // Cleanup is test-owned and only prevents a failing implementation orphaning
  // the deliberately hung fixture. It does not make assertReaped pass.
  if (existsSync(recordPath)) {
    const child = await record();
    if (isRunning(child.pid)) process.kill(child.pid, "SIGKILL");
  }
  await Promise.all([...ownedCwds].map((cwd) => rm(cwd, { recursive: true, force: true })));
  await rm(directory, { recursive: true, force: true });
});

describe("OMP stdio against an actual child process", () => {
  it("decodes split ready/reply JSONL including split UTF-8 and waits for child exit", async () => {
    const answer = await bounded(invokeFor("split")(GEMINI, input, new AbortController().signal));
    expect(answer).toMatchObject({
      text: "Cần xác định ngân sách trước khi tư vấn.",
      requestedModel: GEMINI, reportedModel: GEMINI, fallbackUsed: false,
      usage: { inputTokens: 19, outputTokens: 13 },
    });
    const child = await assertReaped();
    expect(child.stdinClosed).toBe(true);
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0]).toMatchObject({
      path: "/v1/chat/completions", body: { model: GEMINI, stream: false },
    });
    expect(child.requests[0].body).not.toHaveProperty("tools");
    expect(relative(repository, child.cwd).startsWith("..")).toBe(true);
  });

  it("accepts matching bare model ID only after isolation verification and preserves reported provenance", async () => {
    const answer = await bounded(invokeFor("bare-model")(GEMINI, input, new AbortController().signal));
    expect(answer).toMatchObject({ requestedModel: GEMINI, reportedModel: "gemini-3.8-flash", fallbackUsed: false });
    expect(answer.text).toBe("Cần xác định ngân sách trước khi tư vấn.");
    await assertReaped();
  });

  it("lets the owned attempt deadline govern a slow reply instead of a provider-local cancellation", async () => {
    const before = process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
    process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = "40";
    try {
      const answer = await bounded(invokeFor("upstream-watchdog")(GEMINI, input, new AbortController().signal));
      expect(answer).toMatchObject({
        text: "Cần xác định ngân sách trước khi tư vấn.",
        requestedModel: GEMINI, reportedModel: GEMINI, fallbackUsed: false,
      });
      await assertReaped();
    } finally {
      if (before === undefined) delete process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS;
      else process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS = before;
    }
  });

  it.each(["oversized", "oversized-unterminated"])("rejects a >1 MiB line in %s mode without waiting for EOF", async (mode) => {
    const error = await failure(invokeFor(mode)(GEMINI, input, new AbortController().signal));
    expect(error.code).toBe("output_limit");
    expect(error).not.toHaveProperty("text");
    await assertReaped();
  });

  it.each([
    ["malformed", "protocol"], ["invalid-body", "protocol"], ["wrong-id", "protocol"],
    ["early-exit", "child_exit"], ["partial-exit", "child_exit"],
    ["mismatch", "model_mismatch"], ["refusal", "refusal"],
  ] as const)("rejects %s before publishing any answer", async (mode, code) => {
    const error = await failure(invokeFor(mode)(GEMINI, input, new AbortController().signal));
    expect(error.code).toBe(code);
    expect(error).not.toHaveProperty("text");
    await assertReaped();
  });

  it.each([
    [401, "auth"], [403, "permission"], [429, "rate_limited"], [499, "protocol"], [503, "upstream"],
  ] as const)("classifies HTTP %s without discarding status", async (status, code) => {
    const error = await failure(invokeFor(`http-${status}`)(GEMINI, input, new AbortController().signal));
    expect(error.code).toBe(code);
    expect(error.status).toBe(status);
    await assertReaped();
  });

  it("kills and reaps a SIGTERM-resistant child on attempt deadline, not caller abort", async () => {
    const controller = new AbortController();
    const error = await failure(invokeFor("hang", 750)(GEMINI, input, controller.signal));
    expect(controller.signal.aborted).toBe(false);
    expect(error.code).toBe("attempt_timeout");
    await assertReaped();
  });

  it("kills and reaps a SIGTERM-resistant child on caller abort with a distinct error type", async () => {
    const controller = new AbortController();
    const operation = invokeFor("hang", 10_000)(GEMINI, input, controller.signal);
    // Attach the rejection handler immediately, before waiting for the child.
    const outcome = failure(operation);
    await waitForRequest();
    controller.abort();
    const error = await outcome;
    expect(error.code).toBe("aborted");
    await assertReaped();
  });

  it("does not spawn a child for an already-aborted caller", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await failure(invokeFor("hang")(GEMINI, input, controller.signal));
    expect(error.code).toBe("aborted");
    expect(existsSync(recordPath)).toBe(false);
  });

  it("fails closed before sending a prompt when effective config cannot be isolated", async () => {
    const invoke = createOmpInvoker({
      command: process.execPath, args: [fixture, "split", recordPath], deadlineMs: 2_000,
      configVerifier: async (cwd: string) => {
        ownedCwds.add(cwd);
        throw new ModelError("configuration", "Synthetic effective fallback chain isolation failure");
      },
    });
    const error = await failure(invoke(GEMINI, input, new AbortController().signal));
    expect(error.code).toBe("configuration");
    expect(existsSync(recordPath)).toBe(false);
    expect(ownedCwds.size).toBe(1);
    for (const cwd of ownedCwds) expect(existsSync(cwd)).toBe(false);
  });

  it("sends newlines and shell metacharacters as data, never as executable commands", async () => {
    const sentinel = join(directory, "SHELL_EXECUTED");
    const hostileText = `Xin chào\n$(touch '${sentinel}'); touch '${sentinel}'\n\`touch '${sentinel}'\` && echo injected | cat`;
    const answer = await bounded(invokeFor("split")(GEMINI, {
      purpose: "answer", messages: [{ role: "user", content: hostileText }],
    }, new AbortController().signal));
    expect(answer.text).toBe("Cần xác định ngân sách trước khi tư vấn.");
    expect(existsSync(sentinel)).toBe(false);
    const child = await assertReaped();
    expect(child.requests).toHaveLength(1);
    expect(child.requests[0].body.messages[0]).toEqual({ role: "user", content: hostileText });
  });
});
