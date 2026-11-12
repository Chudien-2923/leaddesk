import {afterAll,beforeAll,describe,expect,it} from "vitest";
import { createConversationService } from "../../src/server/conversation/service";
import { createConversationRepository } from "../../src/server/db/conversations";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { startTestDatabase,type TestDatabase } from "./setup";
const provenance={text:"{}",requestedModel:"google-antigravity/gemini-3.8-flash" as const,reportedModel:"google-antigravity/gemini-3.8-flash",fallbackUsed:false};
const citation={chunkId:"22222222-2222-4222-8222-222222222222",documentId:"33333333-3333-4333-8333-333333333333",releaseId:"44444444-4444-4444-8444-444444444444",title:"Giá mẫu",excerpt:"Phí Meta 5 triệu, media 10 triệu."};
describe("persistent conversation worker restart",()=>{
 let db:TestDatabase;beforeAll(async()=>{db=await startTestDatabase();},120_000);afterAll(async()=>{await db?.stop();},30_000);
 it("continues facts and messages in a fresh worker without exposing another visitor's state",async()=>{
  const repository=createConversationRepository(db.pool),a=await repository.createConversation(),b=await repository.createConversation();
  const dependencies={pool:db.pool,owner:{conversationId:a.id,token:a.token},getActiveRelease:async()=>({releaseId:citation.releaseId,policy:DEFAULT_POLICY}),retrieveContext:async()=>({citations:[citation],text:citation.excerpt,estimatedTokens:30}),extractLeadFacts:async()=>({facts:{service:"meta_ads" as const,business:"Demo shop",budget:{kind:"total" as const,totalMonthlyVnd:15_000_000},startDate:"2026-12-01"},model:provenance}),answerWithSources:async()=>({kind:"grounded" as const,text:"Gói Meta mẫu có phí 5 triệu, media từ 10 triệu.",sourceIds:[citation.chunkId],model:provenance}),getLeadService:()=>{throw new Error("No consent: CRM must not be constructed");},getBookingService:async()=>{throw new Error("No CRM: Calendar must not be constructed");},handoffService:{submitHandoff:async()=>{throw new Error("No handoff request");}},now:()=>new Date("2026-11-11T02:00:00Z")};
  const first=await createConversationService(dependencies).handleEvent({type:"message",text:"Tổng 15 triệu, shop demo muốn chạy Meta tháng tới"},new AbortController().signal);
  expect(first.qualification.status).toBe("qualified");expect(first.allowedActions).not.toContain("select_slot");
  const reopened=await createConversationService(dependencies).getView();
  expect(reopened.facts.budget).toEqual({kind:"total",totalMonthlyVnd:15_000_000});expect(reopened.messages).toEqual(first.messages);expect(reopened.messages.some(message=>message.role==="assistant"&&message.citations?.[0]?.chunkId===citation.chunkId)).toBe(true);
  const other=await createConversationService({...dependencies,owner:{conversationId:b.id,token:b.token}}).getView();expect(other.messages).toEqual([]);
  await expect(createConversationService({...dependencies,owner:{conversationId:a.id,token:b.token}}).getView()).rejects.toThrow();
 });
});
