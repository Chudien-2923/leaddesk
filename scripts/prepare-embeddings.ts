// Explicit operator command; network access occurs only here, never in embedding runtime.
// Invoke with NODE_OPTIONS=--conditions=react-server for server-only imports.
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { E5_MODEL_ID, E5_MODEL_REVISION, E5_DIMENSIONS, E5_FILES, E5_MODEL_DIRECTORY, type E5Manifest } from "../src/server/knowledge/embedding";

const controller = new AbortController();
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const staging = `${E5_MODEL_DIRECTORY}.preparing-${randomUUID()}`;
const backup = `${E5_MODEL_DIRECTORY}.previous-${randomUUID()}`;
const lockPath = `${E5_MODEL_DIRECTORY}.prepare.lock`;
let lock: FileHandle | undefined;
let backedUp = false;
let activated = false;
try {
  await mkdir(path.dirname(E5_MODEL_DIRECTORY), { recursive: true });
  lock = await open(lockPath, "wx");
  await mkdir(path.join(staging, "onnx"), { recursive: true });
  const manifest: E5Manifest = { model: E5_MODEL_ID, revision: E5_MODEL_REVISION, dimensions: E5_DIMENSIONS, dtype: "fp32", files: {} };
  for (const file of E5_FILES) {
    controller.signal.throwIfAborted();
    const response = await fetch(`https://huggingface.co/${E5_MODEL_ID}/resolve/${E5_MODEL_REVISION}/${file}`, { signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`Artifact download failed (${response.status})`);
    const hash = createHash("sha256");
    let bytes = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        bytes += chunk.length;
        callback(null, chunk);
      },
    });
    // Bridge the browser stream structurally; Node and DOM stream declarations differ.
    const reader = response.body.getReader();
    async function* downloadChunks() {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          yield next.value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    // ONNX bytes stream directly to disk; never arrayBuffer() the model.
    await pipeline(Readable.from(downloadChunks()), meter, createWriteStream(path.join(staging, file), { flags: "wx" }), { signal: controller.signal });
    const expectedBytes = response.headers.get("content-encoding") ? null : response.headers.get("content-length");
    if (!bytes || (expectedBytes !== null && Number(expectedBytes) !== bytes)) throw new Error("Artifact byte count mismatch");
    manifest.files[file] = { sha256: hash.digest("hex"), bytes };
    console.log(JSON.stringify({ artifact: file, bytes, sha256: manifest.files[file].sha256 }));
  }
  await writeFile(path.join(staging, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  try { await rename(E5_MODEL_DIRECTORY, backup); backedUp = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  try { await rename(staging, E5_MODEL_DIRECTORY); activated = true; }
  catch (error) {
    if (backedUp) { await rename(backup, E5_MODEL_DIRECTORY); backedUp = false; }
    throw error;
  }
  if (backedUp) await rm(backup, { recursive: true });
  console.log(JSON.stringify({ status: "prepared", model: E5_MODEL_ID, revision: E5_MODEL_REVISION, dimensions: E5_DIMENSIONS, dtype: "fp32", semanticCalibration: "UNCALIBRATED" }));
} catch {
  console.error(JSON.stringify({ status: "failed", code: "EMBEDDING_PREPARATION_FAILED", cacheActivated: activated }));
  process.exitCode = 1;
} finally {
  await rm(staging, { recursive: true, force: true });
  if (lock) { await lock.close(); await rm(lockPath, { force: true }); }
  process.removeListener("SIGINT", cancel);
  process.removeListener("SIGTERM", cancel);
}
