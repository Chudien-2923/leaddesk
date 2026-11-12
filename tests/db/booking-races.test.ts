import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { createConversationRepository,type ConversationOwner } from "../../src/server/db/conversations";
import { createLeadService } from "../../src/server/leads/crm";
import { createBookingService } from "../../src/server/booking/service";
import { DEFAULT_POLICY } from "../../src/domain/policy";
import { startTestDatabase,type TestDatabase } from "./setup";
import type { CalendarClient, CalendarEvent } from "../../src/server/integrations/google-calendar";
const now=()=>new Date("2026-11-11T02:00:00Z");
const slot={startUtc:"2026-11-12T02:00:00.000Z",endUtc:"2026-11-12T02:30:00.000Z",timeZone:"Asia/Ho_Chi_Minh" as const};
const facts={service:"meta_ads",business:"Demo store",hasWebsite:true,budget:{kind:"total",totalMonthlyVnd:15_000_000},startDate:"2026-12-01"};
const hubspot={findContactByEmail:async()=>({id:"contact"}),createContact:async()=>({id:"contact"}),createNote:async()=>({id:"note"}),findNoteByMarker:async()=>null,updateNote:async()=>({id:"note"})};
let db:TestDatabase;let policy=DEFAULT_POLICY;
let calendarCase=0;
let calendarId="";
const getActiveRelease=async()=>({releaseId:"demo-release",policy});
async function qualifiedOwner(){const repo=createConversationRepository(db.pool),c=await repo.createConversation();const owner={conversationId:c.id,token:c.token};await repo.saveConversation({...owner,state:{},facts,factsVersion:1,policyVersion:DEFAULT_POLICY.version});await createLeadService({pool:db.pool,owner,hubspot,getActiveRelease,now}).submitLead({contact:{name:"Demo",email:`${c.id}@example.com`},consent:true,factsVersion:1},"crm");return owner;}
function provider(unknown=false){
 const events=new Map<string,CalendarEvent>();let inserts=0;
 const calendar:CalendarClient={freeBusy:async()=>[],insertEvent:async(input)=>{inserts++;const event:CalendarEvent={id:input.eventId,startUtc:input.slot.startUtc,endUtc:input.slot.endUtc,status:"confirmed"};events.set(input.eventId,event);if(unknown)throw Object.assign(new Error("synthetic after provider commit"),{outcome:"unknown",code:"timeout"});return event;},getEvent:async(id:string)=>events.get(id)??null};
 return {calendar,events,get inserts(){return inserts;}};
}
function service(owner:ConversationOwner,calendar:CalendarClient){const leadService=createLeadService({pool:db.pool,owner,hubspot,getActiveRelease,now});return createBookingService({pool:db.pool,owner,calendar,calendarId,leadService,getActiveRelease,now});}
describe("booking reservation and recovery",()=>{
 beforeAll(async()=>{db=await startTestDatabase();},120_000);afterAll(async()=>{await db?.stop();},30_000);beforeEach(()=>{policy=DEFAULT_POLICY;calendarId=`case-${++calendarCase}@group.calendar.google.com`;});
 it("does not create a Calendar event before explicit confirmation",async()=>{
  const owner=await qualifiedOwner(),p=provider(),api=service(owner,p.calendar);
  await api.listSlots();expect(p.inserts).toBe(0);
  await expect(api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:false as never},"not-confirmed")).rejects.toThrow();expect(p.inserts).toBe(0);
 });
 it("creates only one event for a replay or a new key on the same logical booking",async()=>{
  const owner=await qualifiedOwner(),p=provider(),api=service(owner,p.calendar);
  const first=await api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"confirm-a");expect(first).toMatchObject({status:"booked",slot});
  expect(await api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"confirm-a")).toMatchObject(first);
  expect(await api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"confirm-b")).toMatchObject(first);expect(p.inserts).toBe(1);
 });
 it("reserves a slot durably so two conversations cannot both create it",async()=>{
  const [a,b]=await Promise.all([qualifiedOwner(),qualifiedOwner()]),p=provider();
  const outcomes=await Promise.all([service(a,p.calendar).confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"race-a"),service(b,p.calendar).confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"race-b")]);
  expect(outcomes.map(v=>v.status).sort()).toEqual(["booked","slot_unavailable"]);expect(p.inserts).toBe(1);
 });
 it("requalifies a changed active policy before confirming an old offer",async()=>{
  const owner=await qualifiedOwner(),p=provider(),api=service(owner,p.calendar);await api.listSlots();
  policy={...DEFAULT_POLICY,version:"higher-fee",services:{...DEFAULT_POLICY.services,meta_ads:{...DEFAULT_POLICY.services.meta_ads,managementMonthlyVnd:7_000_000}}};
  expect(await api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"stale")).toMatchObject({status:"stale"});expect(p.inserts).toBe(0);
 });
 it("reconciles a lost provider acknowledgement by the same stable event ID without inserting again",async()=>{
  const owner=await qualifiedOwner(),p=provider(true),api=service(owner,p.calendar);
  const result=await api.confirmBooking({startUtc:slot.startUtc,factsVersion:1,confirmed:true},"uncertain");expect(result).toMatchObject({status:"unknown",operationId:expect.any(String)});
  if(result.status!=="unknown")throw new Error("expected unknown");
  expect(await api.reconcileBooking(result.operationId)).toMatchObject({status:"booked",slot,eventId:[...p.events.keys()][0]});expect(p.inserts).toBe(1);
 });
 it("reports unavailable Calendar reads rather than showing an empty free schedule",async()=>{
  const owner=await qualifiedOwner(),p=provider();
  p.calendar.freeBusy=async()=>{throw new Error("synthetic Calendar outage");};
  await expect(service(owner,p.calendar).listSlots()).rejects.toMatchObject({code:"CALENDAR_AVAILABILITY_UNAVAILABLE"});
  expect(p.inserts).toBe(0);
 });
});
