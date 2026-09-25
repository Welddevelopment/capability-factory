import{createPrivateKey,sign}from"node:crypto";
import{composedRecoveryDigest}from"../../src/product/composed-runtime-recovery.js";
import type{FamilyLifecycleReceipt}from"../../src/product/durable-family-registry.js";
import type{CF047LifecycleAuthority,CF047LifecycleRequest}from"../../src/product/registry-snapshot-mixed-family-executor.js";

const privateKeyPem=`-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEILYjoTvXFRFnLkeFFFnF2Zh1520yeV4eA2HGCZusYmTr
-----END PRIVATE KEY-----
`;
const publicKeyPem=`-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEArKKiXtaC9PSbnjSSaCMxVrX59UrOH42P64vhX8lzhz0=
-----END PUBLIC KEY-----
`;
const issuer="cf047-test-fixture-issuer",keyId="cf047-test-ed25519-v1";
const canonical=(value:unknown):string=>value===null||typeof value!=="object"?JSON.stringify(value):Array.isArray(value)?`[${value.map(canonical).join(",")}]`:`{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;

export function createCF047FixtureLifecycleAuthority():CF047LifecycleAuthority{const privateKey=createPrivateKey(privateKeyPem);return{trust:{trustedLifecycleKeys:{[keyId]:{issuer,algorithm:"Ed25519",publicKeyPem}},maximumLifecycleAgeMs:24*60*60*1000,maximumSnapshotTtlMs:60*60*1000},issue(input:CF047LifecycleRequest):FamilyLifecycleReceipt{const payload={schemaVersion:"3.0"as const,signatureAlgorithm:"Ed25519"as const,...input,issuer,keyId};return{...payload,signature:sign(null,Buffer.from(canonical(payload)),privateKey).toString("base64")}}}}

export function substituteLifecycleSignature(receipt:FamilyLifecycleReceipt):FamilyLifecycleReceipt{return{...receipt,signature:Buffer.from(composedRecoveryDigest(receipt),"hex").toString("base64")}}
