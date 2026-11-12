// Test-only OMP JSONL peer. Never used by application inference or as a fallback.
import { writeFileSync } from "node:fs";

const [mode, recordPath] = process.argv.slice(2);
const record = { pid: process.pid, cwd: process.cwd(), requests: [], stdinClosed: false };
const save = () => writeFileSync(recordPath, JSON.stringify(record));
save();
const keepAlive = setInterval(() => {}, 1_000);
if (mode === "hang") process.on("SIGTERM", () => {});

function write(bytes) {
  const pending = Promise.withResolvers();
  process.stdout.write(bytes, (error) => error ? pending.reject(error) : pending.resolve());
  return pending.promise;
}
async function fragmented(bytes) {
  // Include a split inside the multibyte Vietnamese text, not just ASCII framing.
  const marker = bytes.indexOf(Buffer.from("ầ"));
  const cuts = [1, 5, 17, ...(marker >= 0 ? [marker + 1, marker + 2] : []), bytes.length];
  let offset = 0;
  for (const end of [...new Set(cuts)].sort((a, b) => a - b)) {
    await write(bytes.subarray(offset, end));
    offset = end;
    // Real delays intentionally force separate stdout turns in this child;
    // fake timers in the parent process cannot drive this process's event loop.
    const pause = Promise.withResolvers();
    setTimeout(pause.resolve, 5);
    await pause.promise;
  }
}

await fragmented(Buffer.from('{"ready":true,"version":"test-only"}\n'));
let pending = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { pending += chunk; });
process.stdin.on("end", async () => {
  record.stdinClosed = true;
  try {
    record.requests = pending.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    save();
    const request = record.requests[0];
    if (record.requests.length !== 1 || !request || request.path !== "/v1/chat/completions"
      || request.body?.stream !== false || "tools" in request.body
      || !Array.isArray(request.body.messages)
      || request.body.messages.some((message) => !["system", "user", "assistant"].includes(message.role))) {
      await write(JSON.stringify({ id: request?.id, status: 422, body: { error: { message: "Bad request contract" } } }) + "\n");
      process.exitCode = 22;
      clearInterval(keepAlive);
      return;
    }
    if (mode === "upstream-watchdog") {
      // Reproduce a provider-local first-event watchdog masking its timeout as 499.
      const watchdogMs = Number(process.env.PI_STREAM_FIRST_EVENT_TIMEOUT_MS ?? 40);
      const expired = await new Promise(resolve => {
        let watchdog;
        const response = setTimeout(() => { clearTimeout(watchdog); resolve(false); }, 100);
        if (watchdogMs > 0) watchdog = setTimeout(() => { clearTimeout(response); resolve(true); }, watchdogMs);
      });
      record.watchdogExpired = expired;
      save();
      if (expired) {
        await write(JSON.stringify({ id: request.id, status: 499, body: { error: { type: "request_aborted", message: "Request was aborted" } } }) + "\n");
        return;
      }
    }
    if (mode === "hang") return;
    if (mode === "early-exit") {
      process.exitCode = 23;
      clearInterval(keepAlive);
      return;
    }
    if (mode === "malformed") {
      await write('{"id": nope}\n');
    } else if (mode === "oversized" || mode === "oversized-unterminated") {
      // Exceed the byte budget while staying a single line, even without a newline.
      await write('{"id":' + JSON.stringify(request.id) + ',"padding":"');
      for (let index = 0; index < 17; index++) await write("x".repeat(65_536));
      if (mode === "oversized") await write('"}\n');
      return; // Deliberately remain alive: the parent must kill/reap, not await EOF.
    } else {
      const body = {
        id: "chatcmpl-fixture", object: "chat.completion", created: 0,
        model: mode === "bare-model" ? "gemini-3.8-flash"
          : mode === "mismatch" ? "openai-codex/gpt-5.6-luna" : request.body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Cần xác định ngân sách trước khi tư vấn." } }],
        usage: { prompt_tokens: 19, completion_tokens: 13, total_tokens: 32 },
      };
      let status = 200;
      if (mode.startsWith("http-")) status = Number(mode.slice(5));
      if (status !== 200) {
        await write(JSON.stringify({ id: request.id, status, body: { error: { message: "Synthetic provider failure", type: "provider_error" } } }) + "\n");
      } else {
        if (mode === "refusal") body.choices = [{ index: 0, finish_reason: "content_filter", message: { role: "assistant", content: null, refusal: "Synthetic refusal" } }];
        if (mode === "invalid-body") body.choices = [];
        const response = { id: mode === "wrong-id" ? "not-the-request" : request.id, status, body };
        await fragmented(Buffer.from(JSON.stringify(response) + "\n"));
      }
      if (mode === "partial-exit") process.exitCode = 17;
    }
  } catch (error) {
    process.stderr.write(String(error));
    process.exitCode = 24;
  } finally {
    if (!["hang", "oversized", "oversized-unterminated"].includes(mode)) clearInterval(keepAlive);
  }
});
