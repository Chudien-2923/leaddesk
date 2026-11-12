import { z } from "zod";
import { contactSchema } from "../../domain/contact";
import type { Citation, Classification, Contact, LeadFacts, Qualification, Slot } from "../../domain/types";
import type { ModelSelector } from "../ai/types";

const actionKey=z.string().min(1).max(256);
const factsVersion=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const conversationEventSchema=z.discriminatedUnion("type",[
  z.object({type:z.literal("message"),text:z.string().trim().min(1).max(4000)}).strict(),
  z.object({type:z.literal("submit_contact"),contact:contactSchema,consent:z.literal(true),factsVersion,key:actionKey}).strict(),
  z.object({type:z.literal("request_handoff"),contact:contactSchema,consent:z.literal(true),reason:z.string().trim().min(1).max(4000),key:actionKey}).strict(),
  z.object({type:z.literal("select_slot"),startUtc:z.iso.datetime({offset:true})}).strict(),
  z.object({type:z.literal("confirm_slot"),startUtc:z.iso.datetime({offset:true}),factsVersion,confirmed:z.literal(true),key:actionKey}).strict(),
]);
export type ConversationEvent=z.infer<typeof conversationEventSchema>;
export type ConversationAction=ConversationEvent["type"];
export type CrmViewStatus="none"|"saved"|"partial"|"unknown"|"failed";
export interface ModelProvenance { requestedModel:ModelSelector;reportedModel:string;fallbackUsed:boolean }
export interface ChatMessage { id:string;role:"user"|"assistant";text:string;citations?:Citation[];model?:ModelProvenance }
export interface ChatView {
  conversationId:string;
  messages:ChatMessage[];
  citations:Citation[];
  facts:LeadFacts;
  factsVersion:number;
  factsValidationPending:boolean;
  policyVersion:string|null;
  qualification:Qualification;
  missingFields:string[];
  contact:Contact|null;
  crm:{status:CrmViewStatus;operationId?:string;safeCode?:string};
  allowedActions:ConversationAction[];
  slots:Slot[];
  selectedSlot:Slot|null;
  booking:{status:string;eventId?:string;slot?:Slot;operationId?:string;crmSyncStatus?:string}|null;
  handoff:{status:"saved";handoffId:string}|null;
  safeError:{code:string;message:string}|null;
}
export interface ActionGateInput {
  qualification:Classification;
  crmStatus:CrmViewStatus;
  hasConsent:boolean;
  selectedSlot:string|null;
  booked:boolean;
  factsValidationPending:boolean;
}
export function allowedActions(input:ActionGateInput):ConversationAction[]{
  const actions:ConversationAction[]=["message","request_handoff"];
  if(input.booked || input.factsValidationPending)return actions;
  if(input.qualification!=="qualified")return actions;
  if(input.crmStatus!=="saved")return [...actions,"submit_contact"];
  if(!input.hasConsent)return actions;
  actions.push("select_slot");
  if(input.selectedSlot)actions.push("confirm_slot");
  return actions;
}
