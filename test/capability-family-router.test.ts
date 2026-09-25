import{createHash}from"node:crypto";
import{cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync}from"node:fs";
import{tmpdir}from"node:os";
import{join}from"node:path";
import{fileURLToPath}from"node:url";
import{afterEach,describe,expect,it}from"vitest";
import{createFamilyRouteReceipts,validateFamilyRouteReceipt,type FamilyRouteReceipt}from"../src/product/capability-family-router.js";
import{composedRecoveryDigest}from"../src/product/composed-runtime-recovery.js";
const directory=fileURLToPath(new URL("../validation/cf-031-family-routing-benchmark-v1/",import.meta.url));const roots:string[]=[];
afterEach(()=>{for(const r of roots.splice(0))rmSync(r,{recursive:true,force:true})});
function resign(r:FamilyRouteReceipt){const{receiptDigest:_d,...u}=r;r.receiptDigest=composedRecoveryDigest(u)}
function modifiedRegistry(mutate:(registry:any)=>void,{reseal=false}={}){const root=mkdtempSync(join(tmpdir(),"cf031-"));roots.push(root);cpSync(directory,root,{recursive:true});const path=join(root,"registry.json"),registry=JSON.parse(readFileSync(path,"utf8"));mutate(registry);writeFileSync(path,JSON.stringify(registry));if(reseal){const seal=JSON.parse(readFileSync(join(root,"seal.json"),"utf8"));seal.registrySha256=createHash("sha256").update(readFileSync(path)).digest("hex");const{sealDigest:_d,...u}=seal;seal.sealDigest=composedRecoveryDigest(u);writeFileSync(join(root,"seal.json"),JSON.stringify(seal))}return root}
describe("CF-031 provenance-bound cross-family routing",()=>{
  it("matches the exhaustive baseline for all frozen goals and never executes a family",()=>{const a=createFamilyRouteReceipts(directory),b=createFamilyRouteReceipts(directory);expect(a).toEqual(b);expect(a).toHaveLength(10);expect(a.every(x=>x.counterfactual.matches&&x.executionAttempted===false)).toBe(true);expect(a.map(x=>x.outcome)).toEqual(["selected","selected","selected","selected","selected","selected","precise-handoff","precise-handoff","rejected","selected"]);expect(a.filter(x=>x.outcome==="selected").map(x=>x.reason)).toEqual(["selected-retained","selected-constructible","selected-trusted-existing","selected-retained","selected-trusted-existing","selected-constructible","selected-trusted-existing"])});
  it("separates missing authority, ambiguous operations, unsupported conversion and unhealthy retention",()=>{const r=createFamilyRouteReceipts(directory);expect(r.find(x=>x.goalId==="database-authority-handoff")).toMatchObject({outcome:"precise-handoff",reason:"missing-authority"});expect(r.find(x=>x.goalId==="ambiguous-materialize")).toMatchObject({outcome:"precise-handoff",reason:"ambiguous-operation"});expect(r.find(x=>x.goalId==="unsupported-conversion")).toMatchObject({outcome:"rejected",reason:"missing-capability"});const stale=r.find(x=>x.goalId==="stale-retained-fallback")!;expect(stale.selectedCandidateId).toBe("sqlite-existing-archive");expect(stale.candidates.find(x=>x.candidateId==="sqlite-stale-archive")?.rejectionCodes).toContain("retention-unhealthy")});
  it.each([
    ["family evidence substitution",(r:FamilyRouteReceipt)=>{r.candidates[0]!.familyEvidenceDigest="f".repeat(64)}],
    ["verifier evidence reuse",(r:FamilyRouteReceipt)=>{r.candidates[0]!.candidateEvidenceDigest=r.candidates[1]!.candidateEvidenceDigest}],
    ["false safety metadata",(r:FamilyRouteReceipt)=>{r.candidates[0]!.objective[1]=0}],
    ["false cost metadata",(r:FamilyRouteReceipt)=>{r.candidates[0]!.objective[3]+=99}],
    ["authority conflation",(r:FamilyRouteReceipt)=>{const c=r.candidates.find(x=>x.candidateId==="database-retained-apply")!;c.rejectionCodes=[];c.eligible=true}],
    ["false explanation",(r:FamilyRouteReceipt)=>{r.reason="selected-constructible"}],
    ["replayed receipt under another goal",(r:FamilyRouteReceipt)=>{r.goalId="document-build"}],
  ])("blocks re-signed %s",(_label,mutate)=>{const r=structuredClone(createFamilyRouteReceipts(directory)[0]!);mutate(r);resign(r);expect(()=>validateFamilyRouteReceipt(r,directory)).toThrow()});
  it("blocks registry drift, cross-family evidence substitution, evidence reuse and circular dependencies",()=>{for(const path of[
    modifiedRegistry(r=>{r.candidates[0].costEstimate=0}),
    modifiedRegistry(r=>{r.candidates[0].familyEvidenceDigest=r.families[1].evidenceBoundary.evidenceDigest},{reseal:true}),
    modifiedRegistry(r=>{r.candidates[0].candidateEvidenceDigest=r.candidates[1].candidateEvidenceDigest},{reseal:true}),
    modifiedRegistry(r=>{r.candidates[0].dependencies=[r.candidates[1].candidateId];r.candidates[1].dependencies=[r.candidates[0].candidateId]},{reseal:true}),
  ])expect(()=>createFamilyRouteReceipts(path)).toThrow()});
});
