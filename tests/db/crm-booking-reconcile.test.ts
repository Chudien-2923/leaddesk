import {afterAll,beforeAll,expect,it} from "vitest";
import {createLeadService,createCrmBookingReconciler} from "../../src/server/leads/crm";
import {createBookingService} from "../../src/server/booking/service";
import {createConversationRepository} from "../../src/server/db/conversations";
import {DEFAULT_POLICY} from "../../src/domain/policy";
import {startTestDatabase,type TestDatabase} from "./setup";
const adminId="11111111-1111-4111-8111-111111111111";
let db:TestDatabase;
beforeAll(async()=>{db=await startTestDatabase();},120_000);afterAll(async()=>{await db?.stop();},30_000);
it("reads a committed Note update after its lost acknowledgement without another CRM write or Calendar insert",async()=>{
 const before=process.env.ADMIN_USER_ID;process.env.ADMIN_USER_ID=adminId;
 try{
  const repo=createConversationRepository(db.pool),c=await repo.createConversation(),owner={conversationId:c.id,token:c.token};
  await repo.saveConversation({...owner,state:{},facts:{service:"meta_ads",business:"Demo",hasWebsite:true,budget:{kind:"total",totalMonthlyVnd:15_000_000},startDate:"2026-12-01"},factsVersion:1,policyVersion:DEFAULT_POLICY.version});
  let remoteBody="",updates=0;
  const hubspot={findContactByEmail:async()=>({id:"contact"}),createContact:async()=>({id:"contact"}),createNote:async()=>({id:"note"}),findNoteByMarker:async()=>({id:"note",body:remoteBody}),updateNote:async(_id:string,body:string)=>{updates++;remoteBody=body;throw Object.assign(new Error("lost acknowledgement"),{outcome:"unknown",code:"timeout"});}};
  const getActiveRelease=async()=>({releaseId:"synthetic",policy:DEFAULT_POLICY}),now=()=>new Date("2026-11-11T02:00:00Z");
  const leadService=createLeadService({pool:db.pool,owner,hubspot,getActiveRelease,now});await leadService.submitLead({contact:{name:"Demo",email:"demo@example.com"},consent:true,factsVersion:1},"crm");
  let inserts=0;
  const calendar={freeBusy:async()=>[],insertEvent:async(input:{eventId:string;slot:{startUtc:string;endUtc:string}})=>{inserts++;return{id:input.eventId,startUtc:input.slot.startUtc,endUtc:input.slot.endUtc,status:"confirmed"};},getEvent:async()=>null};
  const booking=await createBookingService({pool:db.pool,owner,calendar,calendarId:"recovery@group.calendar.google.com",leadService,getActiveRelease,now}).confirmBooking({startUtc:"2026-11-12T02:00:00.000Z",factsVersion:1,confirmed:true},"booking");
  expect(booking).toMatchObject({status:"booked",crmSyncStatus:"unknown"});
  const operation=await db.pool.query<{id:string}>("SELECT id FROM integration_operations WHERE conversation_id=$1 AND kind='crm_booking_update'",[c.id]);
  expect(await createCrmBookingReconciler({pool:db.pool,hubspot}).reconcileCrmBooking(operation.rows[0].id,adminId)).toEqual({status:"succeeded"});
  expect(updates).toBe(1);expect(inserts).toBe(1);
  expect((await db.pool.query("SELECT crm_sync_status FROM bookings WHERE conversation_id=$1",[c.id])).rows).toEqual([{crm_sync_status:"succeeded"}]);
 }finally{if(before===undefined)delete process.env.ADMIN_USER_ID;else process.env.ADMIN_USER_ID=before;}
});
