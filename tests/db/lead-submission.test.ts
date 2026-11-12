import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createLeadService } from "../../src/server/leads/crm";
import { createConversationRepository, type ConversationOwner } from "../../src/server/db/conversations";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { startTestDatabase, type TestDatabase } from "./setup";
const facts={service:"meta_ads",business:"Cửa hàng demo",hasWebsite:true,budget:{kind:"total",totalMonthlyVnd:15_000_000},startDate:"2026-12-01"};
const contact={name:"Khách demo",email:"demo@example.com"};
const clock=()=>new Date("2026-11-11T02:00:00Z");
describe("consent and CRM outcome gates",()=>{
 let db:TestDatabase; let owner:ConversationOwner;
 beforeAll(async()=>{db=await startTestDatabase();},120_000);
 afterAll(async()=>{await db?.stop();},30_000);
 beforeEach(async()=>{
  const repo=createConversationRepository(db.pool), created=await repo.createConversation();
  owner={conversationId:created.id,token:created.token};
  await repo.saveConversation({...owner,state:{},facts,factsVersion:1,policyVersion:DEFAULT_POLICY.version});
 });
 function service(mode:"success"|"partial"|"unknown"="success"){
  const writes:string[]=[];
  const hubspot={
   findContactByEmail:async()=>({id:"existing-contact"}),
   createContact:async()=>{writes.push("contact");return{id:"created-contact"};},
   createNote:async()=>{writes.push("note");if(mode!=="success")throw Object.assign(new Error("synthetic"),{outcome:mode==="unknown"?"unknown":"failed",code:mode==="unknown"?"timeout":"permission"});return{id:"saved-note"};},
   findNoteByMarker:async()=>null,
   updateNote:async()=>{writes.push("update");return{id:"saved-note"};},
  };
  return {api:createLeadService({pool:db.pool,owner,hubspot,getActiveRelease:async()=>({releaseId:"synthetic-release",policy:DEFAULT_POLICY}),now:clock}),writes};
 }
 it("does not write CRM without explicit consent or with stale facts",async()=>{
  const {api,writes}=service();
  await expect(api.submitLead({contact,consent:false as never,factsVersion:1},"no-consent")).rejects.toThrow();
  await expect(api.submitLead({contact,consent:true,factsVersion:0},"stale")).rejects.toThrow();
  expect(writes).toEqual([]);
 });
 it("does not move an unqualified visitor into CRM",async()=>{
  await createConversationRepository(db.pool).saveConversation({...owner,state:{},facts:{...facts,budget:{kind:"total",totalMonthlyVnd:1_000_000}},factsVersion:2,policyVersion:DEFAULT_POLICY.version});
  const {api,writes}=service();
  await expect(api.submitLead({contact,consent:true,factsVersion:2},"under-budget")).rejects.toThrow();
  expect(writes).toEqual([]);
 });
 it("reuses an existing contact and saves only one note on replay",async()=>{
  const {api,writes}=service();
  const result=await api.submitLead({contact,consent:true,factsVersion:1},"same-action");
  expect(result).toMatchObject({status:"saved",contactId:"existing-contact",noteId:"saved-note"});
  expect(await api.submitLead({contact,consent:true,factsVersion:1},"same-action")).toEqual(result);
  expect(writes).toEqual(["note"]);
  const saved=await db.pool.query("SELECT granted FROM consents WHERE conversation_id=$1 AND purpose='crm'",[owner.conversationId]);
  expect(saved.rows).toEqual([{granted:true}]);
 });
 it("retains Contact identity on explicit Note failure and does not advertise saved",async()=>{
  const {api}=service("partial");
  expect(await api.submitLead({contact,consent:true,factsVersion:1},"partial")).toMatchObject({status:"partial",contactId:"existing-contact"});
 });
 it("records timeout as unknown and never blindly creates another Note on replay",async()=>{
  const {api,writes}=service("unknown");
  const result=await api.submitLead({contact,consent:true,factsVersion:1},"unknown");
  expect(result).toMatchObject({status:"unknown",operationId:expect.any(String)});
  expect(await api.submitLead({contact,consent:true,factsVersion:1},"unknown")).toEqual(result);
  expect(writes).toEqual(["note"]);
 });
 it("refreshes the same saved Note after changed facts and renewed consent",async()=>{
  const {api,writes}=service();
  await api.submitLead({contact,consent:true,factsVersion:1},"initial");
  await createConversationRepository(db.pool).saveConversation({...owner,state:{},facts:{...facts,budget:{kind:"total",totalMonthlyVnd:16_000_000}},factsVersion:2,policyVersion:DEFAULT_POLICY.version});
  expect(await api.submitLead({contact,consent:true,factsVersion:2},"renewed")).toMatchObject({status:"saved",contactId:"existing-contact",noteId:"saved-note"});
  expect(await api.getSavedLead()).toMatchObject({factsVersion:2,policyVersion:DEFAULT_POLICY.version});
  expect(writes).toEqual(["note","update"]);
  expect((await db.pool.query("SELECT facts_version::int FROM consents WHERE conversation_id=$1 AND purpose='crm' ORDER BY facts_version",[owner.conversationId])).rows).toEqual([{facts_version:1},{facts_version:2}]);
 });
});
