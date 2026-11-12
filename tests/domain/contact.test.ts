import { expect, it } from "vitest";
import { contactSchema } from "../../src/domain/contact";
it("rejects a malformed address and empty contact name before saving a lead",()=>{
  expect(()=>contactSchema.parse({name:"Demo",email:"not-an-email"})).toThrow();
  expect(()=>contactSchema.parse({name:"   ",email:"demo@example.com"})).toThrow();
});
it("normalizes surrounding spaces and email case without adding optional contact data",()=>{
  expect(contactSchema.parse({name:"  Khách demo  ",email:"  DEMO@EXAMPLE.COM  "})).toEqual({name:"Khách demo",email:"demo@example.com"});
});
