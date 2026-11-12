import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKnowledgePublisher } from "../../src/server/knowledge/publish";
import { createReleaseRepository } from "../../src/server/db/releases";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { startTestDatabase, type TestDatabase } from "./setup";
const adminId="11111111-1111-4111-8111-111111111111";
const tokenizer={count:async(text:string)=>text.length+2,split:async(text:string)=>[text]};
const vector=Array.from({length:384},(_,i)=>i===0?1:0);
describe("atomic knowledge release activation",()=>{
 let db:TestDatabase;
 beforeAll(async()=>{db=await startTestDatabase();},120_000);
 afterAll(async()=>{await db?.stop();},30_000);
 it("keeps prior documents and policy active when preparing the next release fails",async()=>{
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async(texts:string[])=>texts.map(()=>vector)});
  const first=await publish({documents:[{title:"Giá mẫu",body:"Meta: phí 5 triệu và media 10 triệu."}],policy:DEFAULT_POLICY},adminId);
  expect(first.status).toBe("ready");
  const repository=createReleaseRepository(db.pool);
  expect((await repository.getActiveRelease()).releaseId).toBe(first.releaseId);
  const nextPolicy={...DEFAULT_POLICY,version:"changed",services:{...DEFAULT_POLICY.services,meta_ads:{...DEFAULT_POLICY.services.meta_ads,managementMonthlyVnd:7_000_000}}};
  const failed=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async()=>{throw new Error("synthetic embedding failure");}});
  await failed({documents:[{title:"Giá mới",body:"Meta: phí 7 triệu và media 10 triệu."}],policy:nextPolicy},adminId).catch(()=>undefined);
  expect(await repository.getActiveRelease()).toEqual({releaseId:first.releaseId,policy:DEFAULT_POLICY});
 });
 it("publishes price evidence from the same structured policy rather than a copied old tariff",async()=>{
  const nextPolicy={...DEFAULT_POLICY,version:"new-fee",services:{...DEFAULT_POLICY.services,meta_ads:{...DEFAULT_POLICY.services.meta_ads,managementMonthlyVnd:7_000_000}}};
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async(texts:string[])=>texts.map(()=>vector)});
  const result=await publish({documents:[{title:"Bảng giá",kind:"pricing",body:"Meta: phí quản lý 5.000.000 VND; media 10.000.000 VND."}],policy:nextPolicy},adminId);
  expect(result.status).toBe("ready");
  const source=await db.pool.query<{text:string}>("SELECT c.text FROM knowledge_chunks c JOIN knowledge_documents d ON d.id=c.document_id AND d.release_id=c.release_id WHERE c.release_id=$1 AND d.kind='pricing' ORDER BY c.ordinal",[result.releaseId]);
  const published=source.rows.map(row=>row.text).join("\n");
  expect(published).toMatch(/\b7[,.]000[,.]000\b/);
  expect(published).not.toMatch(/\b5[,.]000[,.]000\b/);
 });
 it("keeps an authorization revision bound to immutable policy contents",async()=>{
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async(texts:string[])=>texts.map(()=>vector)});
  const documents=[{title:"Tariff",body:"Demo tariff"}];
  const first=await publish({documents,policy:DEFAULT_POLICY},adminId);
  const changed={...DEFAULT_POLICY,services:{...DEFAULT_POLICY.services,meta_ads:{...DEFAULT_POLICY.services.meta_ads,managementMonthlyVnd:6_000_000}}};
  expect((await publish({documents,policy:changed},adminId)).status).toBe("failed");
  expect(await createReleaseRepository(db.pool).getActiveRelease()).toEqual({releaseId:first.releaseId,policy:DEFAULT_POLICY});
 });
 it("allows only one policy content to claim a revision under concurrent publication",async()=>{
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async(texts:string[])=>texts.map(()=>vector)});
  const first={...DEFAULT_POLICY,version:"concurrent-policy"};
  const second={...first,services:{...first.services,meta_ads:{...first.services.meta_ads,managementMonthlyVnd:6_000_000}}};
  const results=await Promise.all([publish({documents:[{title:"A",body:"Demo A"}],policy:first},adminId),publish({documents:[{title:"B",body:"Demo B"}],policy:second},adminId)]);
  expect(results.map(result=>result.status).sort()).toEqual(["failed","ready"]);
 });
 it("accepts a persistable revision and rejects an overflowing revision before activation",async()=>{
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed:async(texts:string[])=>texts.map(()=>vector)});
  const documents=[{title:"Length boundary",body:"Demo"}];
  const boundary={...DEFAULT_POLICY,version:"v".repeat(128)};
  const first=await publish({documents,policy:boundary},adminId);
  expect(first.status).toBe("ready");
  await expect(publish({documents,policy:{...boundary,version:"v".repeat(129)}},adminId)).rejects.toThrow();
  expect(await createReleaseRepository(db.pool).getActiveRelease()).toEqual({releaseId:first.releaseId,policy:boundary});
 });
});
