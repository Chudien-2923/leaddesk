import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const probe = fileURLToPath(new URL("../fixtures/embedding-cache-probe.ts", import.meta.url));
const ownedDirectories: string[] = [];
const cases = ["absent cache", "missing model artifact", "corrupt model artifact", "malformed manifest"] as const;

async function prepareCache(directory: string, failure: typeof cases[number]) {
  if (failure === "absent cache") return;
  const model = path.join(directory, ".local/models/Xenova/multilingual-e5-small");
  await mkdir(path.join(model, "onnx"), { recursive: true });
  if (failure === "malformed manifest") {
    await writeFile(path.join(model, "manifest.json"), "{invalid-json");
    return;
  }
  const files: Record<string, { sha256: string; bytes: number }> = {};
  // Tiny cache artifacts only exercise readiness/integrity, never semantic quality.
  // Keep earlier files intact so verification reaches the missing/corrupt ONNX file.
  for (const name of ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model.onnx"]) {
    const expected = Buffer.from(`synthetic cache artifact: ${name}`);
    files[name] = { sha256: createHash("sha256").update(expected).digest("hex"), bytes: expected.length };
    if (name === "onnx/model.onnx") {
      if (failure === "missing model artifact") continue;
      const corrupt = Buffer.from(expected);
      corrupt[0] ^= 1; // Same length: catches content corruption, not just truncation.
      await writeFile(path.join(model, name), corrupt);
    } else await writeFile(path.join(model, name), expected);
  }
  await writeFile(path.join(model, "manifest.json"), JSON.stringify({
    model: "Xenova/multilingual-e5-small",
    revision: "761b726dd34fb83930e26aab4e9ac3899aa1fa78",
    dimensions: 384,
    dtype: "fp32",
    files,
  }));
}

afterEach(async () => {
  await Promise.all(ownedDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("local E5 readiness without usable cache", () => {
  // A fake-vector fallback, success after a load failure, or any fetch makes this fail.
  it.each(cases)("reports not-ready without remote fallback for %s", async failure => {
    const directory = await mkdtemp(path.join(tmpdir(), "leaddesk-e5-failure-"));
    ownedDirectories.push(directory);
    await prepareCache(directory, failure);
    const { stdout } = await execFileAsync(process.execPath, [
      "--conditions=react-server", "--import", import.meta.resolve("tsx"), probe,
    ], { cwd: directory, timeout: 15_000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(stdout)).toEqual({
      query: "EMBEDDING_NOT_READY",
      passage: "EMBEDDING_NOT_READY",
      tokenizer: "EMBEDDING_NOT_READY",
      networkAttempts: 0,
    });
  }, 20_000);
});
