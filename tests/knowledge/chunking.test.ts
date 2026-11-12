import { describe, expect, it } from "vitest";
import { chunkDocument, type E5Tokenizer } from "../../src/server/knowledge/chunking";
// Controlled tokenizer is only the segmentation boundary. Production chunking,
// size enforcement and content preservation remain real; semantic quality is not claimed.
const tokenizer: E5Tokenizer = {
  count: async text => Array.from(text).length + 2,
  split: async (text, maxTokens) => {
    const chars=Array.from(text), result:string[]=[];
    for(let i=0;i<chars.length;i+=maxTokens-2) result.push(chars.slice(i,i+maxTokens-2).join(""));
    return result;
  },
};
describe("bounded knowledge chunks",()=>{
  it("rejects oversized documents instead of silently omitting their tail",async()=>{
    await expect(chunkDocument({documentId:"doc",title:"Demo",body:"x".repeat(20_001)},tokenizer)).rejects.toThrow();
  });
  it("keeps a price together with its qualifying conditions when the paragraph fits",async()=>{
    const body="Meta Ads: phí 5 triệu/tháng; media tối thiểu 10 triệu/tháng. Không cam kết ROAS.";
    const chunks=await chunkDocument({documentId:"pricing",title:"Bảng giá",body},tokenizer);
    expect(chunks.map(chunk=>chunk.text)).toEqual([body]);
  });
  it("bounds prefixed chunks and preserves the final qualifying condition of a long document",async()=>{
    const body=Array.from({length:180},(_,i)=>`Dòng-${i} nội dung minh họa.`).join("\n")+"\nĐIỀU_KIỆN_CUỐI: cần website.";
    const chunks=await chunkDocument({documentId:"pricing",title:"Bảng giá",body},tokenizer);
    for(const chunk of chunks) expect(await tokenizer.count(`passage: ${chunk.text}`)).toBeLessThanOrEqual(512);
    expect(chunks.some(chunk=>chunk.text.includes("ĐIỀU_KIỆN_CUỐI: cần website."))).toBe(true);
    for(let i=0;i<180;i++) expect(chunks.some(chunk=>chunk.text.includes(`Dòng-${i} nội dung minh họa.`))).toBe(true);
  });
});
