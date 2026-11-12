import "server-only";

export interface E5Tokenizer {
  count(text: string): Promise<number>;
  split(text: string, maxTokens: number): Promise<string[]>;
}
export interface ChunkDraft {
  documentId: string;
  title: string;
  text: string;
  ordinal: number;
  tokenCount: number;
}
export const MAX_DOCUMENT_CHARACTERS = 20_000;
export const MAX_E5_TOKENS = 512;
export const TARGET_CHUNK_TOKENS = 320;
export const MAX_OVERLAP_TOKENS = 50;
export const PASSAGE_PREFIX = "passage: ";

/** Never splits a fitting paragraph, including its price and qualifying conditions. */
export async function chunkDocument(
  input: { documentId: string; title: string; body: string },
  tokenizer: E5Tokenizer,
): Promise<ChunkDraft[]> {
  if (!input.documentId || !input.title.trim() || !input.body.trim()) throw new Error("Knowledge document must have an ID, title and body");
  if (Array.from(input.body).length > MAX_DOCUMENT_CHARACTERS) throw new Error("Knowledge document exceeds 20000 characters");
  const count = (text: string) => tokenizer.count(PASSAGE_PREFIX + text);
  const units: string[] = [];
  // Keep separators with the preceding paragraph; no suffix of the source is discarded.
  const paragraphs = input.body.match(/[\s\S]+?(?:\n[\t ]*\n|$)/g) ?? [];
  for (const paragraph of paragraphs) {
    if (await count(paragraph) <= MAX_E5_TOKENS) {
      units.push(paragraph);
      continue;
    }
    const lines = paragraph.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    for (const line of lines) {
      if (await count(line) <= TARGET_CHUNK_TOKENS) units.push(line);
      else {
        // Reserve room for prefix/special tokens, then check the exact prefixed input below.
        const prefixTokens = await tokenizer.count(PASSAGE_PREFIX);
        const parts = await tokenizer.split(line, TARGET_CHUNK_TOKENS - prefixTokens);
        if (!parts.length || parts.join("") !== line) throw new Error("Tokenizer split must preserve the complete source text");
        for (const part of parts) {
          if (!part || await count(part) > MAX_E5_TOKENS) throw new Error("Tokenizer produced an oversized passage");
          units.push(part);
        }
      }
    }
  }
  const chunks: ChunkDraft[] = [];
  let current: string[] = [];
  const emit = async () => {
    const text = current.join("");
    if (!text) return;
    const tokenCount = await count(text);
    if (tokenCount > MAX_E5_TOKENS) throw new Error("Passage exceeds E5 token limit");
    chunks.push({ documentId: input.documentId, title: input.title, text, ordinal: chunks.length, tokenCount });
  };
  for (const unit of units) {
    if (current.length && await count(current.join("") + unit) > TARGET_CHUNK_TOKENS) {
      await emit();
      const overlap: string[] = [];
      for (let i = current.length - 1; i >= 0; i--) {
        if (await tokenizer.count(current[i] + overlap.join("")) > MAX_OVERLAP_TOKENS) break;
        overlap.unshift(current[i]);
      }
      current = overlap;
      // A whole fitting paragraph takes precedence over overlap and the soft target.
      if (await count(current.join("") + unit) > MAX_E5_TOKENS) current = [];
    }
    current.push(unit);
  }
  await emit();
  return chunks;
}
