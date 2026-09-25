import{cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync}from"node:fs";
import{tmpdir}from"node:os";
import{join}from"node:path";
import{fileURLToPath}from"node:url";
import{afterEach,describe,expect,it}from"vitest";
import{runMixedFamilyFaultCampaign}from"../src/product/mixed-family-fault-campaign.js";

const validation=fileURLToPath(new URL("../validation/cf-038-seeded-mixed-family-fault-v1/",import.meta.url));
const cf033=fileURLToPath(new URL("../validation/cf-033-mixed-family-goal-v1/",import.meta.url));
const cf031=fileURLToPath(new URL("../validation/cf-031-family-routing-benchmark-v1/",import.meta.url));
const cf032=fileURLToPath(new URL("../validation/cf-032-runtime-family-conformance-v1/",import.meta.url));
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true})});

async function run(directory=validation){const root=mkdtempSync(join(tmpdir(),"cf038-"));roots.push(root);return runMixedFamilyFaultCampaign({directory,workRoot:join(root,"work"),cf033Directory:cf033,cf031Directory:cf031,cf032Directory:cf032})}

describe("CF-038 seeded mixed-family fault campaign",()=>{
  it("runs every frozen seed through native family worlds and preserves the terminal invariants",async()=>{const result=await run();expect(result).toMatchObject({status:"passed",cases:24,uniqueSchedules:24,nativeExecutions:24,invariants:12,originalSealsModified:0,modelCalls:0,paidSpendUsd:0,effects:{intendedWrites:72,unauthorizedWrites:0,crossFamilyWrites:0,blindRetries:0,parentResumptions:24,secretLeaks:0}});expect(result.blockedFaults).toBeGreaterThan(300);expect(result.minimalCounterexamples).toBeGreaterThan(300)});
  it("exercises every mutation boundary and rejects unsafe evidence before writes",async()=>{const result=await run();const unsafe=["stale-route","quarantined-route","continue-replanned","mutate-manifest","mutate-proposal","mutate-authority","mutate-verifier","mutate-observer","mutate-lifecycle","cross-family-artifact","cross-family-evidence","conflicting-native","lost-response-before-commit","blind-retry","aggregate-early","aggregate-substituted","parent-conflict","replacement-same-version"] as const;for(const event of unsafe){const transitions=result.caseReceipts.flatMap(x=>x.transitions).filter(x=>x.event===event);expect(transitions.length,event).toBeGreaterThan(0);expect(transitions.some(x=>!x.accepted&&x.writesDelta===0),event).toBe(true)}});
  it("survives crash, duplicate, lost-response and reordered completion interleavings without duplicate effects",async()=>{const result=await run();for(const receipt of result.caseReceipts){expect(receipt.writes).toBe(3);expect(receipt.parentResumptions).toBe(1);expect(receipt.blindRetries).toBe(0);expect(receipt.transitions.some(x=>x.event.startsWith("crash-")&&x.accepted)).toBe(true);expect(receipt.transitions.some(x=>x.event==="duplicate-native"||x.event==="lost-response-after-commit")).toBe(true)}});
  it("is deterministic for the frozen seeds and schedules",async()=>{const first=await run(),second=await run();expect(second.receiptDigest).toBe(first.receiptDigest);expect(second.caseReceipts.map(x=>x.scheduleDigest)).toEqual(first.caseReceipts.map(x=>x.scheduleDigest))});
  it("fails closed if the frozen campaign changes",async()=>{const root=mkdtempSync(join(tmpdir(),"cf038-seal-"));roots.push(root);cpSync(validation,root,{recursive:true});const path=join(root,"campaign.json"),campaign=JSON.parse(readFileSync(path,"utf8"));campaign.seeds[0]=1;writeFileSync(path,JSON.stringify(campaign));await expect(run(root)).rejects.toThrow(/drifted/)})
});
