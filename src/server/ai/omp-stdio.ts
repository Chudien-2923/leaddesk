import "server-only";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  MODEL_SELECTORS, ModelError, matchesSelectedModel, parseExtractedFacts,
  throwIfAborted, validateModelInput,
  type ModelInput, type ModelInvoker, type ModelResult, type ModelSelector,
} from "./types";

const DEFAULT_DEADLINE_MS = 90_000;
const MAX_LINE_BYTES = 1_048_576;
const TERMINATE_GRACE_MS = 200;
export interface OmpInvokerOptions {
  command?: string;
  args?: readonly string[];
  deadlineMs?: number;
  /** Construction-only seam for a test transport, never selected from request data. */
  configVerifier?: (cwd: string, signal: AbortSignal) => Promise<void>;
}
type JsonObject = Record<string, unknown>;
function object(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function statusError(status: number): ModelError {
  const code = status === 401 ? "auth" : status === 403 ? "permission"
    : status === 429 ? "rate_limited" : status >= 500 && status <= 599 ? "upstream"
      : status === 408 || status === 504 ? "attempt_timeout"
        : status === 404 ? "configuration" : "protocol";
  return new ModelError(code, `OMP gateway returned status ${status}`, { status });
}
function parseCompletion(body: unknown, model: ModelSelector, input: ModelInput): ModelResult {
  if (!object(body) || !Array.isArray(body.choices) || body.choices.length !== 1
    || !object(body.choices[0])) {
    throw new ModelError("protocol", "OMP response has no single completion");
  }
  const choice = body.choices[0];
  const message = choice.message;
  if (choice.finish_reason === "content_filter"
    || (object(message) && message.refusal !== undefined && message.refusal !== null && message.refusal !== "")) {
    throw new ModelError("refusal", "Provider refused this request");
  }
  if (!object(message) || message.role !== "assistant" || typeof message.content !== "string"
    || message.content.trim().length === 0 || message.tool_calls !== undefined || message.function_call !== undefined
    || choice.finish_reason !== "stop") {
    throw new ModelError("protocol", "OMP response is not a complete assistant text message");
  }
  if (!matchesSelectedModel(model, body.model)) {
    throw new ModelError("model_mismatch", "OMP reported a different model", {
      reportedModel: typeof body.model === "string" ? body.model : undefined,
    });
  }
  if (input.purpose === "extract") parseExtractedFacts(message.content);
  const usage = object(body.usage) ? body.usage : undefined;
  const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  return {
    text: message.content, requestedModel: model, reportedModel: body.model, fallbackUsed: false,
    ...(usage ? { usage: { inputTokens: tokens(usage.prompt_tokens), outputTokens: tokens(usage.completion_tokens) } } : {}),
  };
}

/** Owns one subprocess. Every result, including errors, waits for its close event. */
function runOwnedChild<T>(options: {
  command: string; args: readonly string[]; cwd: string; signal: AbortSignal; deadlineMs: number;
  env?: NodeJS.ProcessEnv;
  consume: (chunk: Buffer, child: ChildProcessWithoutNullStreams) => void;
  complete: () => T;
  started?: (child: ChildProcessWithoutNullStreams) => void;
}): Promise<T> {
  throwIfAborted(options.signal);
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(options.command, [...options.args], {
      cwd: options.cwd, env: options.env, shell: false, stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (cause) {
    reject(new ModelError("configuration", "Could not start OMP subprocess", { cause }));
    return promise;
  }
  let failure: ModelError | undefined;
  let terminating = false;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  const stop = (error: ModelError) => {
    if (closed) return;
    if (!failure || options.signal.aborted) failure = options.signal.aborted
      ? new ModelError("aborted", "Model request cancelled") : error;
    if (terminating) return;
    terminating = true;
    child.stdin.end();
    child.kill("SIGTERM");
    killTimer = setTimeout(() => {
      if (!closed) child.kill("SIGKILL");
    }, TERMINATE_GRACE_MS);
  };
  const onAbort = () => stop(new ModelError("aborted", "Model request cancelled"));
  const deadline = setTimeout(() => stop(new ModelError("attempt_timeout", "OMP subprocess exceeded its deadline")), options.deadlineMs);
  options.signal.addEventListener("abort", onAbort, { once: true });
  child.on("error", (cause) => stop(new ModelError("configuration", "OMP subprocess could not be started", { cause })));
  child.stdin.on("error", (cause) => stop(new ModelError("child_exit", "OMP input stream failed", { cause })));
  child.stdout.on("error", (cause) => stop(new ModelError("protocol", "OMP output stream failed", { cause })));
  child.stdout.on("data", (chunk: Buffer) => {
    if (failure) return;
    try { options.consume(chunk, child); } catch (cause) {
      stop(cause instanceof ModelError ? cause : new ModelError("protocol", "Invalid OMP output", { cause }));
    }
  });
  // Drain diagnostics without retaining or exposing potential provider/account details.
  child.stderr.resume();
  child.once("close", (code, exitSignal) => {
    closed = true;
    clearTimeout(deadline);
    clearTimeout(killTimer);
    options.signal.removeEventListener("abort", onAbort);
    if (options.signal.aborted) failure = new ModelError("aborted", "Model request cancelled");
    if (failure) { reject(failure); return; }
    if (code !== 0 || exitSignal !== null) {
      reject(new ModelError("child_exit", "OMP subprocess exited unsuccessfully"));
      return;
    }
    try { resolve(options.complete()); } catch (cause) {
      reject(cause instanceof ModelError ? cause : new ModelError("protocol", "Invalid OMP output", { cause }));
    }
  });
  if (options.signal.aborted) onAbort();
  if (!failure) {
    try { options.started?.(child); } catch (cause) {
      stop(new ModelError("protocol", "Could not send OMP request", { cause }));
    }
  }
  return promise;
}

async function verifyEffectiveConfiguration(cwd: string, signal: AbortSignal, command: string, deadlineMs: number): Promise<void> {
  let output = "";
  let bytes = 0;
  const decoder = new StringDecoder("utf8");
  const effective = await runOwnedChild({
    command, args: ["config", "get", "retry.fallbackChains"], cwd, signal, deadlineMs,
    started: (child) => child.stdin.end(),
    consume: (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_LINE_BYTES) throw new ModelError("output_limit", "OMP config output exceeds 1 MiB");
      output += decoder.write(chunk);
    },
    complete: () => {
      output += decoder.end();
      try { return parseYaml(output) as unknown; } catch (cause) {
        throw new ModelError("configuration", "Cannot parse OMP effective fallback chains", { cause });
      }
    },
  });
  if (!object(effective) || MODEL_SELECTORS.some((selector) => !Object.hasOwn(effective, selector)
    || !Array.isArray(effective[selector]) || effective[selector].length !== 0)) {
    throw new ModelError("configuration", "OMP effective fallback chains do not disable both exact selectors");
  }
}

async function isolatedCwd(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), "leaddesk-omp-"));
  try {
    await mkdir(join(cwd, ".omp"), { mode: 0o700 });
    await writeFile(join(cwd, ".omp", "config.yml"), stringifyYaml({
      retry: { fallbackChains: Object.fromEntries(MODEL_SELECTORS.map((selector) => [selector, []])) },
    }), { mode: 0o600 });
    return cwd;
  } catch (cause) {
    await rm(cwd, { recursive: true, force: true });
    throw cause;
  }
}

/** Explicit operator smoke helper: performs config verification only, never inference. */
export async function verifyOmpConfiguration(signal: AbortSignal, deadlineMs = DEFAULT_DEADLINE_MS): Promise<void> {
  throwIfAborted(signal);
  const cwd = await isolatedCwd();
  try { await verifyEffectiveConfiguration(cwd, signal, "omp", deadlineMs); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

export function createOmpInvoker(options: OmpInvokerOptions = {}): ModelInvoker {
  const command = options.command ?? "omp";
  const args = options.args ?? ["auth-gateway", "stdio"];
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new ModelError("configuration", "Invalid OMP subprocess deadline");
  const verify = options.configVerifier ?? ((cwd: string, signal: AbortSignal) => verifyEffectiveConfiguration(cwd, signal, command, deadlineMs));
  return async (model, input, signal) => {
    throwIfAborted(signal);
    validateModelInput(input);
    if (!MODEL_SELECTORS.includes(model)) throw new ModelError("configuration", "Unapproved OMP model selector");
    const cwd = await isolatedCwd();
    try {
      try { await verify(cwd, signal); } catch (cause) {
        throwIfAborted(signal);
        if (cause instanceof ModelError && cause.code === "configuration") throw cause;
        throw new ModelError("configuration", "OMP config isolation could not be verified", { cause });
      }
      throwIfAborted(signal);
      const id = randomUUID();
      let ready = false;
      let response: ModelResult | undefined;
      let pending = "";
      let lineBytes = 0;
      const decoder = new StringDecoder("utf8");
      function line(text: string, child: ChildProcessWithoutNullStreams) {
        let frame: unknown;
        try { frame = JSON.parse(text); } catch (cause) {
          throw new ModelError("protocol", "OMP emitted malformed JSONL", { cause });
        }
        if (!object(frame)) throw new ModelError("protocol", "OMP emitted a non-object frame");
        if (!ready) {
          if (frame.ready !== true || typeof frame.version !== "string") throw new ModelError("protocol", "OMP did not send its ready handshake");
          ready = true;
          child.stdin.end(JSON.stringify({
            id, path: "/v1/chat/completions", body: { model, messages: input.messages, stream: false },
          }) + "\n");
          return;
        }
        if (response || frame.id !== id || !Number.isInteger(frame.status)) throw new ModelError("protocol", "OMP response ID or framing is invalid");
        const status = frame.status as number;
        if (status !== 200) throw statusError(status);
        response = parseCompletion(frame.body, model, input);
      }
      return await runOwnedChild({
        command, args, cwd, signal, deadlineMs,
        // This parent owns the bounded attempt deadline. Provider first-event
        // watchdogs can erase their timeout reason into a non-retryable 499.
        // Genuine caller cancellation still terminates/reaps this child above.
        env: { ...process.env, PI_STREAM_FIRST_EVENT_TIMEOUT_MS: "0" },
        consume: (chunk, child) => {
          // Count raw bytes before decoding: also rejects oversized unterminated lines.
          let start = 0;
          for (let index = 0; index < chunk.length; index++) {
            if (chunk[index] !== 10) continue;
            lineBytes += index - start + 1;
            if (lineBytes > MAX_LINE_BYTES) throw new ModelError("output_limit", "OMP JSONL line exceeds 1 MiB");
            pending += decoder.write(chunk.subarray(start, index));
            line(pending, child);
            pending = "";
            lineBytes = 0;
            start = index + 1;
          }
          lineBytes += chunk.length - start;
          if (lineBytes > MAX_LINE_BYTES) throw new ModelError("output_limit", "OMP JSONL line exceeds 1 MiB");
          pending += decoder.write(chunk.subarray(start));
        },
        complete: () => {
          pending += decoder.end();
          if (pending.length || lineBytes) throw new ModelError("protocol", "OMP emitted an unterminated JSONL frame");
          if (!ready || !response) throw new ModelError("child_exit", "OMP exited before returning a completion");
          return response;
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  };
}
export const invokeOmp = createOmpInvoker();
