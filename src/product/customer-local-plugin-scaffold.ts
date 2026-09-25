import { createHash, sign, verify, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_CONTROL_IDS, assertCustomerLocalPluginConformanceReceipt, type CustomerLocalPluginConformanceReceipt } from "./customer-local-plugin-conformance.js";
import { customerLocalPluginHostDigest, type CustomerLocalPluginHostManifestEntry, type PluginHostDoctorReport } from "./customer-local-plugin-host.js";
import type { ReviewedTransportProfile } from "./customer-local-binding-qualification.js";

export const CUSTOMER_LOCAL_PLUGIN_SCAFFOLD_VERSION = "1.0" as const;
const identifier = /^[a-zA-Z][a-zA-Z0-9_.-]{1,119}$/;
const canonical = (value: unknown): string => { if (value === undefined) return "undefined"; if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (value !== null && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`; return JSON.stringify(value); };
export const pluginScaffoldDigest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");
const secretShaped = /CF_CANARY_[A-Z0-9_-]+|(?:bearer|password|secret|token|api[_ -]?key)\s*[:=]\s*[^\s,;}]+/i;

export interface PluginScaffoldMetadata {
  schemaVersion: "1.0"; pluginId: string; providerClass: "map-backed-local" | "callback-local";
  actionAlias: string; observerAlias: string;
  actionProfile: ReviewedTransportProfile; observerProfile: ReviewedTransportProfile;
}
export interface PluginScaffoldResult { projectPath: string; files: string[]; generatedLines: number; decisionCount: number; sourceDigest: string }
export interface PluginReleaseManifest {
  schemaVersion: "1.0"; pluginId: string; releaseVersion: string; sourceDigest: string; buildDigest: string;
  sourceFiles: Array<{ path: string; digest: string }>; buildFiles: Array<{ path: string; digest: string }>;
  providerDigest: string; resolverImplementationDigest: string; actionTransportDigest: string; observerTransportDigest: string;
  actionProfileDigest: string; observerProfileDigest: string; sourcePackageDigest: string;
  conformanceControlDigest: string; createdAt: string; expiresAt: string; executionAuthorityEffect: "none"; activationEffect: "none"; manifestDigest: string;
}
export interface DetachedPluginReleaseSignature { schemaVersion: "1.0"; algorithm: "Ed25519"; signerKeyId: string; manifestDigest: string; signatureBase64: string }
export interface PluginInstallProposal { schemaVersion: "1.0"; state: "reviewed-install-proposal"; tenantId: string; loaderKey: string; entry: CustomerLocalPluginHostManifestEntry; releaseManifestDigest: string; conformanceReceiptDigest: string; doctorReportDigest: string; executionAuthorityEffect: "none"; activationEffect: "none"; proposalDigest: string }

function assertMetadata(metadata: PluginScaffoldMetadata): void {
  if (metadata.schemaVersion !== "1.0" || !identifier.test(metadata.pluginId) || !identifier.test(metadata.actionAlias) || !identifier.test(metadata.observerAlias)) throw new Error("Plugin metadata contains an invalid or injection-shaped identifier.");
  if (metadata.actionAlias === metadata.observerAlias) throw new Error("Action and observer aliases must be distinct and explicit.");
  if (metadata.actionProfile.role !== "action" || metadata.observerProfile.role !== "observer" || metadata.actionProfile.method === metadata.observerProfile.method && metadata.actionProfile.path === metadata.observerProfile.path && metadata.actionProfile.serverUrl === metadata.observerProfile.serverUrl) throw new Error("Action and observer reviewed profiles must be explicit and distinct.");
  if (metadata.actionProfile.implementationDigest === metadata.observerProfile.implementationDigest || metadata.actionProfile.sourceId === metadata.observerProfile.sourceId || !metadata.observerProfile.independentFromDriverIds.includes(metadata.actionProfile.driverId)) throw new Error("Shared action/observer implementations are forbidden.");
  if (secretShaped.test(canonical(metadata))) throw new Error("Plugin scaffold metadata cannot contain credential values.");
}
function safeProjectPath(root: string, pluginId: string): string { const base = resolve(root), target = resolve(base, pluginId); if (target === base || !target.startsWith(`${base}${sep}`) || isAbsolute(pluginId) || pluginId.includes("..")) throw new Error("Plugin scaffold path escaped the explicit output root."); return target; }
function lineCount(value: string): number { return value.split("\n").length; }
function generatedFiles(metadata: PluginScaffoldMetadata): Record<string, string> {
  const contract = `export interface Metadata { alias: string; scopes: string[]; revision: number; revoked: boolean; expiresAt: string }\nexport interface Lease { take(): string; release(): void }\nexport interface Request { alias: string; scope: string; body: unknown }\nexport interface Response { status: number; body: unknown }\n`;
  const plugin = `import type { Lease, Metadata, Request, Response } from "./contract.js";\nconst fail = (boundary: string): never => { throw new Error(boundary + " is not implemented; scaffold remains quarantined."); };\nexport const pluginIdentity = ${JSON.stringify({ schemaVersion: "1.0", pluginId: metadata.pluginId, providerClass: metadata.providerClass, actionAlias: metadata.actionAlias, observerAlias: metadata.observerAlias })} as const;\nexport function inspect(_alias: string): Metadata | null { return fail("credential inspector"); }\nexport async function lease(_alias: string, _scope: string): Promise<Lease> { return fail("one-read lease resolver"); }\nexport async function action(_request: Request, _lease: Lease): Promise<Response> { return fail("action transport"); }\nexport async function observe(_request: Request, _lease: Lease): Promise<Response> { return fail("independent observer transport"); }\nexport function probeAction(): never { return fail("no-write action probe"); }\nexport function probeObserver(): never { return fail("no-write observer probe"); }\nexport function reconcileLostResponse(): never { return fail("lost-response reconciliation"); }\n`;
  const doctor = `import { inspect, probeAction, probeObserver } from "../src/plugin.js";\nconst checks: Array<{id:string, passed:boolean, detail:string}> = [];\nfor (const [id, run] of [["inspector", () => inspect(${JSON.stringify(metadata.actionAlias)})], ["action-probe", probeAction], ["observer-probe", probeObserver]] as const) { try { run(); checks.push({id,passed:false,detail:"Unsafe scaffold unexpectedly returned."}); } catch { checks.push({id,passed:true,detail:"Fail-closed stub confirmed."}); } }\nconsole.log(JSON.stringify({state:"implementation-required",checks,authority:false,activation:false}));\n`;
  return {
    "src/contract.ts": contract,
    "src/plugin.ts": plugin,
    "test/conformance-map.json": `${JSON.stringify({ schemaVersion: "1.0", controls: CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_CONTROL_IDS.map((controlId) => ({ controlId, state: "declared-not-run", expected: "must-pass-after-local-implementation" })) }, null, 2)}\n`,
    "scripts/doctor.ts": doctor,
    "plugin-spec.json": `${JSON.stringify(metadata, null, 2)}\n`,
    "package.json": `${JSON.stringify({ name: `cf-local-plugin-${metadata.pluginId}`, version: "0.0.0", private: true, type: "module", scripts: {} }, null, 2)}\n`,
    "tsconfig.json": `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmitOnError: true, outDir: "dist", rootDir: ".", skipLibCheck: true }, include: ["src/**/*.ts", "scripts/**/*.ts"] }, null, 2)}\n`,
    "README.md": `# ${metadata.pluginId}\n\nFail-closed customer-local plugin scaffold. No credential values, authority, activation, default scopes or passing implementation are generated.\n`,
  };
}

export function scaffoldCustomerLocalPlugin(root: string, metadata: PluginScaffoldMetadata): PluginScaffoldResult {
  assertMetadata(metadata); const projectPath = safeProjectPath(root, metadata.pluginId); const files = generatedFiles(metadata);
  for (const [name, content] of Object.entries(files)) { const target = resolve(projectPath, name); if (!target.startsWith(`${projectPath}${sep}`) || secretShaped.test(content)) throw new Error("Generated scaffold failed path or secret scan."); mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, content, { encoding: "utf8", mode: 0o600, flag: "wx" }); }
  return { projectPath, files: Object.keys(files).sort(), generatedLines: Object.values(files).reduce((sum, item) => sum + lineCount(item), 0), decisionCount: 7, sourceDigest: digestProject(projectPath, ["src", "scripts", "test", "sdk-provenance.json", "sdk-semantic-contract.json", "plugin-spec.json", "package.json", "tsconfig.json", "README.md"].filter((item) => { try { statSync(join(projectPath,item)); return true; } catch { return false; } })).digest };
}

function walk(root: string, relativePath = ""): string[] { const path = join(root, relativePath); if (!statSync(path).isDirectory()) return [relativePath]; return readdirSync(path).sort().flatMap((name) => walk(root, join(relativePath, name))); }
function digestProject(root: string, includes: string[]): { digest: string; files: Array<{ path: string; digest: string }> } {
  const files = includes.flatMap((item) => walk(root, item)).filter((item) => !item.startsWith("dist/")).sort().map((item) => ({ path: item, digest: pluginScaffoldDigest(readFileSync(join(root, item), "utf8")) }));
  return { files, digest: pluginScaffoldDigest(files) };
}
function assertNoDependencyOrScriptAbuse(projectPath: string): void {
  const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8")) as Record<string, unknown>;
  if (canonical(pkg.dependencies ?? {}) !== "{}" || canonical(pkg.devDependencies ?? {}) !== "{}" || canonical(pkg.scripts ?? {}) !== "{}") throw new Error("Plugin project dependencies or package scripts are not allowed in deterministic local build.");
  const config = JSON.parse(readFileSync(join(projectPath, "tsconfig.json"), "utf8")) as Record<string, unknown>;
  const expected = { compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmitOnError: true, outDir: "dist", rootDir: ".", skipLibCheck: true }, include: ["src/**/*.ts", "scripts/**/*.ts"] };
  if (canonical(config) !== canonical(expected)) throw new Error("Plugin TypeScript build configuration changed or contains unsupported build extensions.");
  const allowed = new Set(["src/contract.ts", "src/plugin.ts", "src/sdk-adapter-skeleton.ts", "src/fictional-sdk-modules.d.ts", "src/sdk-adapter-fixture-completion.ts", "scripts/doctor.ts", "test/conformance-map.json", "test/sdk-role-controls.json", "sdk-provenance.json", "sdk-semantic-contract.json", "plugin-spec.json", "package.json", "tsconfig.json", "README.md"]);
  const actual = ["src", "scripts", "test", "plugin-spec.json", "package.json", "tsconfig.json", "README.md"].flatMap((item) => walk(projectPath, item));
  if (actual.some((item) => !allowed.has(item))) throw new Error("Plugin project contains an unexpected source or build-control file.");
}

export function buildCustomerLocalPlugin(projectPath: string): { buildDigest: string; files: Array<{ path: string; digest: string }>; diagnostics: number } {
  assertNoDependencyOrScriptAbuse(projectPath);
  const configPath = join(projectPath, "tsconfig.json"), parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
  if (!parsed) throw new Error("Plugin TypeScript configuration could not be parsed.");
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: false }); const diagnostics = ts.getPreEmitDiagnostics(program); if (diagnostics.length > 0) throw new Error(`Plugin typecheck failed with ${diagnostics.length} diagnostics: ${diagnostics.map((item) => ts.flattenDiagnosticMessageText(item.messageText, " ")).join("; ")}`);
  const emitted = program.emit(); if (emitted.emitSkipped) throw new Error("Plugin deterministic build was skipped.");
  const files = walk(projectPath, "dist").sort().map((item) => ({ path: item, digest: pluginScaffoldDigest(readFileSync(join(projectPath, item), "utf8")) })); const buildDigest = pluginScaffoldDigest(files);
  // A second clean compiler emit must yield the same bytes.
  const second = program.emit(); if (second.emitSkipped) throw new Error("Plugin repeat build was skipped."); const repeated = walk(projectPath, "dist").sort().map((item) => ({ path: item, digest: pluginScaffoldDigest(readFileSync(join(projectPath, item), "utf8")) })); if (pluginScaffoldDigest(repeated) !== buildDigest) throw new Error("Plugin build is nondeterministic.");
  return { buildDigest, files, diagnostics: 0 };
}

export function createPluginReleaseManifest(input: { projectPath: string; metadata: PluginScaffoldMetadata; releaseVersion: string; sourcePackageDigest: string; providerDigest: string; resolverImplementationDigest: string; actionTransportDigest: string; observerTransportDigest: string; createdAt: string; expiresAt: string }): PluginReleaseManifest {
  assertMetadata(input.metadata); if (!/^\d+\.\d+\.\d+$/.test(input.releaseVersion) || Date.parse(input.expiresAt) <= Date.parse(input.createdAt)) throw new Error("Release version or expiry is invalid.");
  const includes = ["src", "scripts", "test", "sdk-provenance.json", "sdk-semantic-contract.json", "plugin-spec.json", "package.json", "tsconfig.json", "README.md"].filter((item) => { try { statSync(join(input.projectPath,item)); return true; } catch { return false; } });
  const source = digestProject(input.projectPath, includes), build = buildCustomerLocalPlugin(input.projectPath);
  const profileDigest = (profile: ReviewedTransportProfile) => { const { reviewedAt: _r, expiresAt: _e, ...value } = profile; return customerLocalPluginHostDigest(value); };
  const withoutDigest = { schemaVersion: "1.0" as const, pluginId: input.metadata.pluginId, releaseVersion: input.releaseVersion, sourceDigest: source.digest, buildDigest: build.buildDigest, sourceFiles: source.files, buildFiles: build.files, providerDigest: input.providerDigest, resolverImplementationDigest: input.resolverImplementationDigest, actionTransportDigest: input.actionTransportDigest, observerTransportDigest: input.observerTransportDigest, actionProfileDigest: profileDigest(input.metadata.actionProfile), observerProfileDigest: profileDigest(input.metadata.observerProfile), sourcePackageDigest: input.sourcePackageDigest, conformanceControlDigest: pluginScaffoldDigest(CUSTOMER_LOCAL_PLUGIN_CONFORMANCE_CONTROL_IDS), createdAt: input.createdAt, expiresAt: input.expiresAt, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  const manifest = { ...withoutDigest, manifestDigest: pluginScaffoldDigest(withoutDigest) }; if (secretShaped.test(canonical(manifest))) throw new Error("Release manifest failed secret scan."); return manifest;
}
export function signPluginRelease(manifest: PluginReleaseManifest, privateKey: KeyObject, signerKeyId: string): DetachedPluginReleaseSignature { if (!identifier.test(signerKeyId)) throw new Error("Signer key ID is invalid."); return { schemaVersion: "1.0", algorithm: "Ed25519", signerKeyId, manifestDigest: manifest.manifestDigest, signatureBase64: sign(null, Buffer.from(manifest.manifestDigest), privateKey).toString("base64") }; }
export function verifyPluginReleaseSignature(manifest: PluginReleaseManifest, signature: DetachedPluginReleaseSignature, publicKey: KeyObject, requiredSignerKeyId?: string): void { const { manifestDigest, ...payload } = manifest; if (manifestDigest !== pluginScaffoldDigest(payload) || signature.schemaVersion !== "1.0" || signature.algorithm !== "Ed25519" || signature.manifestDigest !== manifest.manifestDigest || requiredSignerKeyId && signature.signerKeyId !== requiredSignerKeyId || !verify(null, Buffer.from(manifest.manifestDigest), publicKey, Buffer.from(signature.signatureBase64, "base64"))) throw new Error("Detached plugin release signature is missing, mismatched or invalid."); }

export function proposePluginHostInstall(input: { tenantId: string; loaderKey: string; projectPath: string; metadata: PluginScaffoldMetadata; manifest: PluginReleaseManifest; conformance: CustomerLocalPluginConformanceReceipt; doctor: PluginHostDoctorReport; reviewPhrase: string; signaturePolicy: { required: boolean; signerKeyId?: string; publicKey?: KeyObject }; signature?: DetachedPluginReleaseSignature; existingEntries?: CustomerLocalPluginHostManifestEntry[]; now: string }): PluginInstallProposal {
  if (input.reviewPhrase !== `INSTALL ${input.metadata.pluginId} ${input.manifest.releaseVersion} FOR ${input.tenantId}`) throw new Error("Exact explicit install review is missing.");
  const { manifestDigest, ...manifestPayload } = input.manifest; if (manifestDigest !== pluginScaffoldDigest(manifestPayload) || Date.parse(input.manifest.expiresAt) <= Date.parse(input.now)) throw new Error("Release manifest is tampered or stale.");
  const currentIncludes = ["src", "scripts", "test", "sdk-provenance.json", "sdk-semantic-contract.json", "plugin-spec.json", "package.json", "tsconfig.json", "README.md"].filter((item) => { try { statSync(join(input.projectPath,item)); return true; } catch { return false; } });
  if (input.manifest.pluginId !== input.metadata.pluginId || digestProject(input.projectPath, currentIncludes).digest !== input.manifest.sourceDigest || buildCustomerLocalPlugin(input.projectPath).buildDigest !== input.manifest.buildDigest) throw new Error("Plugin source or deterministic build changed after release.");
  if (input.signaturePolicy.required) { if (!input.signature || !input.signaturePolicy.publicKey) throw new Error("Required release signature is missing."); verifyPluginReleaseSignature(input.manifest, input.signature, input.signaturePolicy.publicKey, input.signaturePolicy.signerKeyId); }
  assertCustomerLocalPluginConformanceReceipt(input.conformance, { bundleId: input.doctor.bundleId, sourcePackageDigest: input.manifest.sourcePackageDigest, schemaVersion: "1.0", credentials: { providerDigest: input.manifest.providerDigest, resolverImplementationDigest: input.manifest.resolverImplementationDigest } as never, action: { transport: { implementationDigest: input.manifest.actionTransportDigest }, profile: input.metadata.actionProfile } as never, observer: { transport: { implementationDigest: input.manifest.observerTransportDigest }, profile: input.metadata.observerProfile } as never } as never, input.now);
  if (input.doctor.tenantId !== input.tenantId || !input.doctor.usableForCf029 || input.doctor.state !== "conformant" || input.doctor.executionAuthorityEffect !== "none" || input.doctor.activationEffect !== "none") throw new Error("Healthy current same-tenant plugin-host doctor evidence is required.");
  const entry: CustomerLocalPluginHostManifestEntry = { schemaVersion: "1.0", bundleId: input.doctor.bundleId, loaderKey: input.loaderKey, sourcePackageDigest: input.manifest.sourcePackageDigest, providerDigest: input.manifest.providerDigest, resolverImplementationDigest: input.manifest.resolverImplementationDigest, actionTransportDigest: input.manifest.actionTransportDigest, observerTransportDigest: input.manifest.observerTransportDigest, actionProfileDigest: input.manifest.actionProfileDigest, observerProfileDigest: input.manifest.observerProfileDigest, actionAlias: input.metadata.actionAlias, observerAlias: input.metadata.observerAlias, actionScope: `${input.metadata.actionProfile.method} ${input.metadata.actionProfile.path}`, observerScope: `${input.metadata.observerProfile.method} ${input.metadata.observerProfile.path}` };
  if ((input.existingEntries ?? []).some((existing) => existing.bundleId === entry.bundleId || existing.loaderKey === entry.loaderKey)) throw new Error("Plugin install conflicts with an existing bundle or loader identity.");
  const withoutDigest = { schemaVersion: "1.0" as const, state: "reviewed-install-proposal" as const, tenantId: input.tenantId, loaderKey: input.loaderKey, entry, releaseManifestDigest: input.manifest.manifestDigest, conformanceReceiptDigest: input.conformance.receiptDigest, doctorReportDigest: input.doctor.reportDigest, executionAuthorityEffect: "none" as const, activationEffect: "none" as const };
  return { ...withoutDigest, proposalDigest: pluginScaffoldDigest(withoutDigest) };
}
