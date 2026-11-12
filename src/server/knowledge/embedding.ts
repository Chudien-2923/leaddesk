import "server-only";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { E5Tokenizer } from "./chunking";
import { AutoTokenizer, pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const E5_MODEL_ID = "Xenova/multilingual-e5-small";
export const E5_MODEL_REVISION = "761b726dd34fb83930e26aab4e9ac3899aa1fa78";
export const E5_DIMENSIONS = 384;
export const E5_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model.onnx"] as const;
export const E5_MODEL_DIRECTORY = path.resolve(process.cwd(), ".local/models", E5_MODEL_ID);
export interface E5Manifest {
  model: typeof E5_MODEL_ID;
  revision: typeof E5_MODEL_REVISION;
  dimensions: typeof E5_DIMENSIONS;
  dtype: "fp32";
  files: Record<string, { sha256: string; bytes: number }>;
}
export class EmbeddingNotReadyError extends Error {
  readonly code = "EMBEDDING_NOT_READY";
  constructor(message = "Local E5 model is not ready; run prepare:embeddings explicitly", options?: ErrorOptions) {
    super(message, options);
    this.name = "EmbeddingNotReadyError";
  }
}
export type Embed = (texts: string[], kind: "query" | "passage", signal?: AbortSignal) => Promise<number[][]>;

async function verifyLocalArtifacts(): Promise<void> {
  const manifest = JSON.parse(await readFile(path.join(E5_MODEL_DIRECTORY, "manifest.json"), "utf8")) as E5Manifest;
  if (manifest.model !== E5_MODEL_ID || manifest.revision !== E5_MODEL_REVISION || manifest.dimensions !== E5_DIMENSIONS || manifest.dtype !== "fp32") {
    throw new Error("Local E5 manifest does not match the pinned model");
  }
  for (const file of E5_FILES) {
    const expected = manifest.files[file];
    if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256) || expected.bytes <= 0) throw new Error("Local E5 manifest is incomplete");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of createReadStream(path.join(E5_MODEL_DIRECTORY, file))) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    if (hash.digest("hex") !== expected.sha256 || bytes !== expected.bytes) throw new Error("Local E5 artifact checksum mismatch");
  }
}

interface E5Runtime { tokenizer: E5Tokenizer; extractor: FeatureExtractionPipeline }
let runtime: Promise<E5Runtime> | undefined;
async function loadRuntime(): Promise<E5Runtime> {
  try {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    await verifyLocalArtifacts();
    const tokenizer = await AutoTokenizer.from_pretrained(E5_MODEL_DIRECTORY, { local_files_only: true });
    const extractor = await pipeline("feature-extraction", E5_MODEL_DIRECTORY, { dtype: "fp32", local_files_only: true });
    const count = async (text: string): Promise<number> => tokenizer.encode(text, { add_special_tokens: true }).length;
    const adapter: E5Tokenizer = {
      count,
      async split(text, maxTokens) {
        if (!Number.isInteger(maxTokens) || maxTokens < 4) throw new Error("Invalid tokenizer split budget");
        const characters = Array.from(text);
        const result: string[] = [];
        let offset = 0;
        while (offset < characters.length) {
          let low = 1;
          let high = characters.length - offset;
          let accepted = 0;
          while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            if (await count(characters.slice(offset, offset + middle).join("")) <= maxTokens) {
              accepted = middle;
              low = middle + 1;
            } else high = middle - 1;
          }
          if (!accepted) throw new Error("Tokenizer cannot fit a source character within the budget");
          const part = characters.slice(offset, offset + accepted).join("");
          // Recheck exact BPE tokenization: boundaries are measured, never estimated.
          if (await count(part) > maxTokens) throw new Error("Tokenizer split exceeds budget");
          result.push(part);
          offset += accepted;
        }
        return result;
      },
    };
    return { tokenizer: adapter, extractor };
  } catch (cause) {
    throw new EmbeddingNotReadyError(undefined, { cause });
  }
}
export async function getE5Tokenizer(): Promise<E5Tokenizer> {
  runtime ??= loadRuntime();
  return (await runtime).tokenizer;
}
export const embed: Embed = async (texts, kind, signal) => {
  signal?.throwIfAborted();
  if (!texts.length) return [];
  runtime ??= loadRuntime();
  const { tokenizer, extractor } = await runtime;
  signal?.throwIfAborted();
  const prefixed: string[] = [];
  for (const text of texts) {
    if (!text.trim()) throw new Error("Cannot embed empty text");
    const value = `${kind}: ${text}`;
    if (await tokenizer.count(value) > 512) throw new Error("Embedding input exceeds E5 token limit; truncation is forbidden");
    prefixed.push(value);
  }
  const tensor = await extractor(prefixed, { pooling: "mean", normalize: true });
  signal?.throwIfAborted();
  const vectors = tensor.tolist() as number[][];
  if (vectors.length !== texts.length) throw new Error("Embedding batch order/size mismatch");
  for (const vector of vectors) {
    const norm = Math.hypot(...vector);
    if (vector.length !== E5_DIMENSIONS || !vector.every(Number.isFinite) || Math.abs(norm - 1) > 0.001) throw new Error("Invalid normalized E5 vector");
  }
  return vectors;
};
