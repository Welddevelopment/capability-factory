import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildCustomerLocalPlugin, scaffoldCustomerLocalPlugin, type PluginScaffoldMetadata } from "../src/product/customer-local-plugin-scaffold.js";
import { createPluginReleaseManifest } from "../src/product/customer-local-plugin-scaffold.js";
import { createReferenceCustomerLocalPluginFixture, type ReferencePluginShape } from "../src/product/customer-local-reference-plugins.js";
import { runCustomerLocalPluginConformance } from "../src/product/customer-local-plugin-conformance.js";
import { CustomerLocalPluginHost, createReferencePluginHostManifest } from "../src/product/customer-local-plugin-host.js";
import { generateCustomerLocalSdkWorkPack, sdkWorkPackDigest, type ApprovedLocalSdkIndex, type SdkRoleReview } from "../src/product/customer-local-sdk-work-pack.js";
import { readinessTestBindingArtifacts, readinessTestPreparation, readinessTestStartInput } from "./product-onboarding-readiness-receipt.test.js";

const temporaryDirectories: string[]=[];
afterEach(async()=>Promise.all(temporaryDirectories.splice(0).map((item)=>rm(item,{recursive:true,force:true}))));
// Real-clock anchor: secret-lease expiry is enforced against real time, so
// fixed historical dates lapse as wall time passes.
const T0=Date.now(),at=(ms:number)=>new Date(T0+ms).toISOString();
async function temp(name:string){const dir=await mkdtemp(path.join(os.tmpdir(),`cf-sdk-pack-${name}-`));temporaryDirectories.push(dir);return dir;}
function fixture(shape:ReferencePluginShape, providerId:string){
  const intake=readinessTestStartInput(); intake.sessionId=`sdk-${providerId}`; const prepared=readinessTestPreparation(intake), built=readinessTestBindingArtifacts(prepared);
  const reference=createReferenceCustomerLocalPluginFixture(shape,{qualifiedAt:at(0),expiresAt:at(86_400_000)});
  const metadata:PluginScaffoldMetadata={schemaVersion:"1.0",pluginId:`${providerId}-plugin`,providerClass:shape==="map-direct"?"map-backed-local":"callback-local",actionAlias:reference.actionAlias,observerAlias:reference.observerAlias,actionProfile:reference.bundle.action.profile,observerProfile:reference.bundle.observer.profile};
  const actionModule=shape==="map-direct"?"fictional-map-sdk":"fictional-callback-sdk",observerModule=shape==="map-direct"?"fictional-map-read-sdk":"fictional-callback-read-sdk";
  const method=(module:string,className:string,methodName:string,overloadId:string,retryCandidate:ApprovedLocalSdkIndex["methods"][number]["retryCandidate"],auth:string,parameters=1)=>({module,className,methodName,overloadId,parameters:Array.from({length:parameters},(_,i)=>({name:`arg${i+1}`,type:"string",required:true,sourcePointer:`#/methods/${methodName}/params/${i}`})),returnType:"Promise<Record<string, unknown>>",errorTypes:["SdkError"],authAliasRequirements:[auth],pagination:"none" as const,retryCandidate,idempotencyCandidate:retryCandidate==="idempotency-key"?"request-id-header":null,sourcePointer:`#/methods/${methodName}/${overloadId}`});
  const sdk:ApprovedLocalSdkIndex={schemaVersion:"1.0",providerId,sourceKind:shape==="map-direct"?"typescript-declarations":"mcp-descriptor",localReference:`fixture://${providerId}/sdk-index`,sourceDigest:sdkWorkPackDigest({providerId,version:1}),approved:true,allowedImports:[actionModule,observerModule],methods:[method(actionModule,"WriteClient","createOrder","v1","idempotency-key",metadata.actionAlias,3),method(actionModule,"WriteClient","ping","v1","read-only",metadata.actionAlias),method(observerModule,"ReadClient","findOrder","v1","read-only",metadata.observerAlias),method(observerModule,"AuditClient","observeOrder","v1","read-only",metadata.observerAlias,2)]};
  const reviews:SdkRoleReview[]=[{role:"action",module:actionModule,className:"WriteClient",methodName:"createOrder",overloadId:"v1",expectedSourcePointer:"#/methods/createOrder/v1",reviewerAlias:"fixtureEngineer",reviewedAt:at(0),exactOneToOne:true},{role:"no-write-probe",module:actionModule,className:"WriteClient",methodName:"ping",overloadId:"v1",expectedSourcePointer:"#/methods/ping/v1",reviewerAlias:"fixtureEngineer",reviewedAt:at(0),exactOneToOne:true},{role:"reconciliation-readback",module:observerModule,className:"ReadClient",methodName:"findOrder",overloadId:"v1",expectedSourcePointer:"#/methods/findOrder/v1",reviewerAlias:"fixtureEngineer",reviewedAt:at(0),exactOneToOne:true},{role:"independent-observer",module:observerModule,className:"AuditClient",methodName:"observeOrder",overloadId:"v1",expectedSourcePointer:"#/methods/observeOrder/v1",reviewerAlias:"fixtureEngineer",reviewedAt:at(0),exactOneToOne:true}];
  return {built,metadata,sdk,reviews};
}

describe("provider-specific SDK implementation work pack",()=>{
  it.each([["map-direct","aurora-sdk"],["callback-queued","mistral-sdk"]] as Array<[ReferencePluginShape,string]>)("normalizes and scaffolds %s metadata without filling engineer semantics",async(shape,provider)=>{
    const root=await temp(provider),f=fixture(shape,provider),scaffold=scaffoldCustomerLocalPlugin(root,f.metadata);
    const pack=generateCustomerLocalSdkWorkPack({outputRoot:root,factoryResult:f.built.factoryResult,scaffold:f.metadata,sdk:f.sdk,reviews:f.reviews});
    expect(pack).toMatchObject({state:"engineer-implementation-required",mappedMethods:4,explicitReviews:4,executionAuthorityEffect:"none",activationEffect:"none"}); expect(pack.blockedUnknowns).toHaveLength(9); expect(pack.conformanceControls).toHaveLength(21);
    expect(pack.normalized).toMatchObject({methodCount:4,parameterCount:7,returnShapeCount:1,errorShapeCount:1});
    const skeleton=await readFile(path.join(scaffold.projectPath,"src/sdk-adapter-skeleton.ts"),"utf8"); expect(skeleton).toContain("requires engineer-owned semantics"); expect(skeleton).not.toContain("credential value");
    // Local fixture declarations only: satisfy type-only imports without installing packages.
    await writeFile(path.join(scaffold.projectPath,"src/fictional-sdk-modules.d.ts"),f.sdk.allowedImports.map((module)=>`declare module ${JSON.stringify(module)} { export interface Client {} }`).join("\n"),{mode:0o600});
    // Completion remains a separate fixture layer; generated skeleton is preserved unchanged.
    await writeFile(path.join(scaffold.projectPath,"src/sdk-adapter-fixture-completion.ts"),`export const engineerOwned = { stableId:"orderRef", idempotency:"request-id-header", reconciliation:"read-before-retry", observerIndependence:true, outcomeRules:"exactly-one" } as const;\n`,{mode:0o600});
    expect(buildCustomerLocalPlugin(scaffold.projectPath).diagnostics).toBe(0);
    const reference=createReferenceCustomerLocalPluginFixture(shape,{qualifiedAt:at(0),expiresAt:at(86_400_000)});
    const release=createPluginReleaseManifest({projectPath:scaffold.projectPath,metadata:f.metadata,releaseVersion:"1.0.0",sourcePackageDigest:reference.bundle.sourcePackageDigest,providerDigest:reference.bundle.credentials.providerDigest,resolverImplementationDigest:reference.bundle.credentials.resolverImplementationDigest,actionTransportDigest:reference.bundle.action.transport.implementationDigest,observerTransportDigest:reference.bundle.observer.transport.implementationDigest,createdAt:at(0),expiresAt:at(86_400_000)});
    expect(release.sourceFiles.map((item)=>item.path)).toEqual(expect.arrayContaining(["src/sdk-adapter-skeleton.ts","src/sdk-adapter-fixture-completion.ts","sdk-provenance.json"]));
    const conformance=await runCustomerLocalPluginConformance({...reference,qualifiedAt:at(0),expiresAt:at(86_400_000)}); expect(conformance.state).toBe("passed");
    const configured=createReferencePluginHostManifest("sdk-work-pack-tenant"),entry=configured.manifest.entries.find((item)=>item.bundleId===reference.bundle.bundleId)!;
    let host=new CustomerLocalPluginHost(configured.manifest,{statePath:path.join(root,`${provider}-host.sqlite`),loaders:configured.loaders,now:()=>at(0)}); expect((await host.load(entry.bundleId)).usableForCf029).toBe(true); host.close();
    host=new CustomerLocalPluginHost(configured.manifest,{statePath:path.join(root,`${provider}-host.sqlite`),loaders:configured.loaders,now:()=>at(60_000)}); expect(host.doctor(entry.bundleId).usableForCf029).toBe(false); expect((await host.load(entry.bundleId)).usableForCf029).toBe(true); host.close();
    console.log(`CF036_METRICS=${JSON.stringify({provider,shape,methodsMapped:pack.mappedMethods,fieldsMapped:pack.mappedFields,explicitReviews:pack.explicitReviews,generatedFiles:pack.generatedFiles.length,generatedLines:pack.generatedLines,manualFixtureFiles:2,blockedUnknowns:pack.blockedUnknowns.length,controlsRemaining:pack.conformanceControls.length})}`);
  });

  it("rejects ambiguous, malicious, conflated, stale and unsafe metadata",async()=>{
    const root=await temp("attacks"),base=fixture("map-direct","attack-sdk"),scaffold=scaffoldCustomerLocalPlugin(root,base.metadata);
    const run=(sdk:ApprovedLocalSdkIndex=base.sdk,reviews:SdkRoleReview[]=base.reviews)=>()=>generateCustomerLocalSdkWorkPack({outputRoot:root,factoryResult:base.built.factoryResult,scaffold:base.metadata,sdk,reviews});
    expect(run({...base.sdk,localReference:"../../escape"})).toThrow();
    expect(run({...base.sdk,allowedImports:["fictional-map-sdk","fictional-map-read-sdk","evil;postinstall"]})).toThrow();
    expect(run({...base.sdk,methods:[...base.sdk.methods,{...base.sdk.methods[0]!}]})).toThrow(/ambiguous/i);
    expect(run({...base.sdk,methods:base.sdk.methods.map((item,index)=>index===0?{...item,returnType:"any"}:item)})).toThrow(/type/i);
    const firstReview=base.reviews[0]!;
    expect(run(base.sdk,base.reviews.map((item)=>item.role==="independent-observer"?{...item,module:firstReview.module,...(firstReview.className?{className:firstReview.className}:{}),methodName:firstReview.methodName,overloadId:firstReview.overloadId,expectedSourcePointer:firstReview.expectedSourcePointer}:item))).toThrow(/conflated|read-only/i);
    expect(run({...base.sdk,methods:base.sdk.methods.map((item,index)=>index===0?{...item,retryCandidate:"read-only"}:item)})).toThrow(/unsafe/i);
    expect(run({...base.sdk,sourceDigest:sdkWorkPackDigest("another-provider")},base.reviews.map((item)=>({...item,expectedSourcePointer:item.expectedSourcePointer.replace("#/methods","#/other")})))).toThrow(/source-mismatched/i);
    expect(run({...base.sdk,methods:base.sdk.methods.map((item,index)=>index===3?{...item,authAliasRequirements:[base.metadata.actionAlias]}:item)})).toThrow(/conflated/i);
    expect(run({...base.sdk,methods:base.sdk.methods.map((item,index)=>index===2?{...item,sourcePointer:"eval(process.env.SECRET)"}:item)})).toThrow(/injection/i);
  });
});
