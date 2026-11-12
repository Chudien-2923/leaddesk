import { expect,it } from "vitest";
import { readMutationJson,safeJson } from "../../src/server/http/guards";
const url="http://127.0.0.1:3000/api/conversations";
it.each([undefined,"https://evil.example","null"])("rejects unsafe mutation origin %s",async origin=>{
 const headers:Record<string,string>={"content-type":"application/json"};if(origin)headers.origin=origin;
 await expect(readMutationJson(new Request(url,{method:"POST",headers,body:"{}"}))).rejects.toThrow();
});
it("enforces actual body bytes even when Content-Length is absent",async()=>{
 const request=new Request(url,{method:"POST",headers:{origin:"http://127.0.0.1:3000","content-type":"application/json"},body:JSON.stringify({text:"x".repeat(2048)})});
 await expect(readMutationJson(request,1024)).rejects.toThrow();
});
it("accepts same-origin JSON without trusting role fields as identity",async()=>{
 const request=new Request(url,{method:"POST",headers:{origin:"http://127.0.0.1:3000","content-type":"application/json"},body:'{"text":"demo"}'});
 expect(await readMutationJson(request)).toEqual({text:"demo"});
});
it("keeps private response data out of shared caches",()=>{expect(safeJson({conversation:"demo"}).headers.get("cache-control")).toContain("no-store");});
it("matches browser Origin to verified loopback Host rather than Next's internal localhost URL",async()=>{
 const request=new Request("http://localhost:3000/api/conversations",{method:"POST",headers:{host:"127.0.0.1:3000",origin:"http://127.0.0.1:3000","content-type":"application/json"},body:"{}"});
 expect(await readMutationJson(request)).toEqual({});
});
it("rejects a different loopback origin when the actual Host is 127.0.0.1",async()=>{
 const request=new Request("http://localhost:3000/api/conversations",{method:"POST",headers:{host:"127.0.0.1:3000",origin:"http://localhost:3000","content-type":"application/json"},body:"{}"});
 await expect(readMutationJson(request)).rejects.toThrow();
});
it("rejects non-loopback Host even if the internal request URL is local",async()=>{
 const request=new Request("http://localhost:3000/api/conversations",{method:"POST",headers:{host:"evil.example",origin:"http://evil.example","content-type":"application/json"},body:"{}"});
 await expect(readMutationJson(request)).rejects.toThrow();
});
