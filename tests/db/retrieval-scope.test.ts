import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {createKnowledgePublisher} from "../../src/server/knowledge/publish";
import {createContextRetriever} from "../../src/server/knowledge/retrieve";
import {DEFAULT_POLICY} from "../../src/domain/policy";
import {startTestDatabase,type TestDatabase} from "./setup";
import {createReleaseRepository} from "../../src/server/db/releases";
const adminId="11111111-1111-4111-8111-111111111111";
const tokenizer={count:async(text:string)=>text.length+2,split:async(text:string)=>[text]};
// Deterministic vectors prove SQL isolation, not semantic retrieval quality.
const vector=Array.from({length:384},(_,i)=>i===0?1:0);
const embed=async(texts:string[])=>texts.map(()=>vector);
describe("public active-release retrieval scope",()=>{
 let db:TestDatabase;beforeAll(async()=>{db=await startTestDatabase();},120_000);afterAll(async()=>{await db?.stop();},30_000);
 it("never retrieves an old, draft or internal source even when its vector is equally close",async()=>{
  const publish=createKnowledgePublisher({pool:db.pool,tokenizer,embed});
  const old=await publish({documents:[{title:"old-public",body:"Old price"}],policy:DEFAULT_POLICY},adminId);
  const current=await publish({documents:[{title:"new-public",kind:"pricing",body:"New public price",visibility:"public"},{title:"internal",body:"Internal notes never for visitors",visibility:"internal"}],policy:DEFAULT_POLICY},adminId);
  await createReleaseRepository(db.pool).createDraft({documents:[{title:"unpublished-draft",body:"Draft price never for visitors"}],policy:DEFAULT_POLICY},adminId);
  const retrieve=createContextRetriever({pool:db.pool,embed,threshold:-1});
  const context=await retrieve("price",current.releaseId);
  expect(new Set(context.citations.map(c=>c.title))).toEqual(new Set(["new-public"]));
  expect(context.text).not.toContain("Internal notes");
  expect(context.citations.every(c=>c.releaseId===current.releaseId)).toBe(true);
  await expect(retrieve("price",old.releaseId)).rejects.toThrow();
 });
});
