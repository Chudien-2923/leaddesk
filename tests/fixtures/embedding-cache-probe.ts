export {};

// A fresh process gives each cache case its own module-level runtime promise.
// Only the cwd-owned temporary cache is visible to the real embedding module.
let networkAttempts = 0;
globalThis.fetch = async () => {
  networkAttempts++;
  throw new Error("Network is forbidden in the local-cache failure probe");
};

// Intentional module-loading boundary: install the network trap before loading
// Transformers or the production module's process-local runtime singleton.
const { embed, getE5Tokenizer, EmbeddingNotReadyError } = await import("../../src/server/knowledge/embedding");
async function outcome(operation: () => Promise<unknown>) {
  try {
    await operation();
    return "unexpected_success";
  } catch (error) {
    return error instanceof EmbeddingNotReadyError ? error.code : "unexpected_error";
  }
}
const query = await outcome(() => embed(["Phí dịch vụ Meta Ads?"], "query"));
const passage = await outcome(() => embed(["Phí quản lý mẫu 5 triệu mỗi tháng."], "passage"));
const tokenizer = await outcome(() => getE5Tokenizer());
console.log(JSON.stringify({ query, passage, tokenizer, networkAttempts }));
