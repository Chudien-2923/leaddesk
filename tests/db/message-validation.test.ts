import {afterAll,beforeAll,expect,it} from "vitest";
import {createConversationRepository} from "../../src/server/db/conversations";
import {createConversationService} from "../../src/server/conversation/service";
import {createLeadService} from "../../src/server/leads/crm";
import {createHandoffService} from "../../src/server/leads/handoff";
import {createBookingService} from "../../src/server/booking/service";
import {ModelError} from "../../src/server/ai/types";
import {DEFAULT_POLICY} from "../../src/domain/policy";
import {startTestDatabase,type TestDatabase} from "./setup";
let db:TestDatabase;beforeAll(async()=>{db=await startTestDatabase();},120_000);afterAll(async()=>{await db?.stop();},30_000);
async function qualifiedSession(){
 const repo=createConversationRepository(db.pool),c=await repo.createConversation(),owner={conversationId:c.id,token:c.token};
 await repo.saveConversation({...owner,state:{},facts:{service:"meta_ads",business:"Demo",hasWebsite:true,budget:{kind:"total",totalMonthlyVnd:15_000_000},startDate:"2026-12-01"},factsVersion:1,policyVersion:DEFAULT_POLICY.version});
 let inserts=0,mode:"failure"|"interrupted"|"unchanged"="failure";const entered=Promise.withResolvers<void>();
 const now=()=>new Date("2026-11-11T02:00:00Z"),getActiveRelease=async()=>({releaseId:"11111111-1111-4111-8111-111111111111",policy:DEFAULT_POLICY});
 const hubspot={findContactByEmail:async()=>({id:"contact"}),createContact:async()=>({id:"contact"}),createNote:async()=>({id:"note"}),findNoteByMarker:async()=>null,updateNote:async()=>({id:"note"})};
 const calendar={freeBusy:async()=>[],insertEvent:async(input:{eventId:string;slot:{startUtc:string;endUtc:string}})=>{inserts++;return{id:input.eventId,startUtc:input.slot.startUtc,endUtc:input.slot.endUtc,status:"confirmed"};},getEvent:async()=>null};
 const leadService=createLeadService({pool:db.pool,owner,hubspot,getActiveRelease,now});
 const bookingService=createBookingService({pool:db.pool,owner,calendar,calendarId:`${c.id}@test.example`,leadService,getActiveRelease,now});
 const deps={pool:db.pool,owner,getActiveRelease,now,getLeadService:()=>leadService,getBookingService:async()=>bookingService,handoffService:createHandoffService({pool:db.pool,owner,getActiveRelease}),retrieveContext:async()=>({citations:[],text:"",estimatedTokens:0}),answerWithSources:async()=>({kind:"unsupported" as const,text:"Chưa có nguồn cho câu này.",sourceIds:[],model:{text:"{}",requestedModel:"google-antigravity/gemini-3.8-flash" as const,reportedModel:"google-antigravity/gemini-3.8-flash",fallbackUsed:false}}),extractLeadFacts:async(_input:unknown,signal:AbortSignal)=>{
  if(mode==="interrupted"){
   const interrupted=Promise.withResolvers<void>();
   const abort=()=>interrupted.reject(new ModelError("aborted","synthetic interruption"));
   signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
   entered.resolve();
   try{await interrupted.promise;}finally{signal.removeEventListener("abort",abort);}
  }
  if(mode==="failure")throw new ModelError("unavailable","synthetic extraction failure");
  return{facts:{},model:{text:"{}",requestedModel:"google-antigravity/gemini-3.8-flash" as const,reportedModel:"google-antigravity/gemini-3.8-flash",fallbackUsed:false}};
 }};
 const api=createConversationService(deps),signal=new AbortController().signal,contact={name:"Demo",email:"demo@example.com"};
 const saved=await api.handleEvent({type:"submit_contact",contact,consent:true,factsVersion:1,key:"consent"},signal);
 const slot=saved.slots[0];await api.handleEvent({type:"select_slot",startUtc:slot.startUtc},signal);
 return{api,deps,repo,owner,leadService,bookingService,slot,entered,contact,setMode(value:typeof mode){mode=value;},get inserts(){return inserts;}};
}
it("does not authorize an old selected slot after the latest message fails validation, even in a fresh worker",async()=>{
 const session=await qualifiedSession(),signal=new AbortController().signal;
 await session.api.handleEvent({type:"message",text:"Đổi ngân sách tổng còn 1 triệu/tháng."},signal);
 const fresh=createConversationService(session.deps);
 const attempted=await fresh.handleEvent({type:"confirm_slot",startUtc:session.slot.startUtc,factsVersion:1,confirmed:true,key:"after-failed-extraction"},signal);
 expect(session.inserts).toBe(0);expect(attempted.booking).toBeNull();expect(attempted.allowedActions).not.toContain("submit_contact");expect(attempted.allowedActions).not.toContain("confirm_slot");
 await expect(session.leadService.submitLead({contact:session.contact,consent:true,factsVersion:1},"bypass-graph")).rejects.toMatchObject({code:"FACTS_VALIDATION_PENDING"});
 session.setMode("unchanged");
 const recovered=await fresh.handleEvent({type:"message",text:"Đính chính: ngân sách tổng vẫn là 15 triệu/tháng."},signal);
 expect(recovered.factsValidationPending).toBe(false);expect(recovered.qualification.status).toBe("qualified");expect(recovered.selectedSlot).toBeNull();
});
it("persists a validation fence before extraction so an interrupted worker cannot expose old booking eligibility",async()=>{
 const session=await qualifiedSession();session.setMode("interrupted");const controller=new AbortController();
 const operation=session.api.handleEvent({type:"message",text:"Ngân sách mới là 1 triệu."},controller.signal).catch(()=>undefined);
 await session.entered.promise;
 try{expect((await session.repo.getConversation(session.owner)).factsValidationPending).toBe(true);}
 finally{controller.abort();await operation;}
 const fresh=await createConversationService(session.deps).getView();
 expect(fresh.allowedActions).not.toContain("select_slot");expect(fresh.allowedActions).not.toContain("submit_contact");expect(fresh.selectedSlot).toBeNull();
 expect(await session.bookingService.confirmBooking({startUtc:session.slot.startUtc,factsVersion:1,confirmed:true},"bypass-graph-after-interruption")).toMatchObject({status:"stale"});expect(session.inserts).toBe(0);
});
