import { createHash } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { composedRecoveryDigest } from "./composed-runtime-recovery.js";

const id = z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const key = z.string().min(1).max(180).regex(/^[A-Za-z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.string().datetime({ offset: true });
const privilege = z.string().regex(/^(insert|update|delete|select):[A-Za-z][A-Za-z0-9_]*$/);
const scalar = z.union([z.string().max(2_000), z.number().int(), z.boolean()]);
const parameterSchema = z.object({ name: id, type: z.enum(["string", "integer", "boolean"]), min: z.number().int().optional(), max: z.number().int().optional() }).strict();
const bindingSchema = z.object({ column: id, parameter: id }).strict();
const predicateSchema = z.object({ column: id, op: z.literal("eq"), parameter: id }).strict();
const statementSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("insert"), table: id, values: z.array(bindingSchema).min(1), conflictColumns: z.array(id).min(1), expectedRows: z.literal(1) }).strict(),
  z.object({ kind: z.literal("update"), table: id, set: z.array(bindingSchema).min(1), where: z.array(predicateSchema).min(1), conflictColumns: z.array(id).min(1), expectedRows: z.literal(1) }).strict(),
  z.object({ kind: z.literal("delete"), table: id, where: z.array(predicateSchema).min(1), conflictColumns: z.array(id).min(1), expectedRows: z.literal(1) }).strict(),
]);
export const scopedDatabaseContractSchema = z.object({
  schemaVersion: z.literal("1.0"), contractId: key, contractVersion: z.string().regex(/^\d+\.\d+\.\d+$/), tenantId: key,
  targetAlias: key, schemaDigest: digest, migrationVersion: key,
  allowlist: z.array(z.object({ table: id, columns: z.array(id).min(1), rowScopeColumns: z.array(id).min(1) }).strict()).min(1),
  parameters: z.array(parameterSchema).min(1), transaction: z.object({ isolation: z.enum(["serializable", "repeatable-read"]), statements: z.array(statementSchema).length(1) }).strict(),
  connection: z.object({ profileId: key, actionIdentity: key, observerIdentity: key, actionPrivileges: z.array(privilege).min(1), observerPrivileges: z.array(privilege).min(1), status: z.enum(["active", "revoked"]), notBefore: time, expiresAt: time }).strict(),
  limits: z.object({ statementLimit: z.literal(1), timeoutMs: z.number().int().positive().max(30_000), rowLimit: z.literal(1) }).strict(),
  approvalKey: key, outcomeVerifierKey: key, workflowKey: key,
}).strict();
export type ScopedDatabaseContract = z.infer<typeof scopedDatabaseContractSchema>;

export interface ScopedDatabaseProposal {
  schemaVersion:"1.0"; proposalId:string; tenantId:string; parentGoalId:string; planId:string; planDigest:string; workItemId:string;
  contractId:string; contractVersion:string; contractDigest:string; schemaDigest:string; migrationVersion:string; targetAlias:string;
  parameters:Record<string,string|number|boolean>; parameterDigest:string; transactionDigest:string; capabilityMaterialDigest:string;
  approvalKey:string; workflowKey:string; proposedAt:string; proposalDigest:string;
}
export interface ScopedDatabaseAuthority { tenantId:string;parentGoalId:string;planId:string;planDigest:string;workItemId:string;targetAlias:string;approvalKey:string;checkedAt:string;expiresAt:string;revoked:boolean;authorityDigest:string }
export type DatabaseObservationClass="completed"|"not-started"|"partial"|"incorrect"|"duplicate"|"collateral"|"unknown"|"unavailable";

const sha=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex");
const quote=(v:string)=>`"${id.parse(v)}"`;
const sqlValue=(v:string|number|boolean|undefined):string|number=>{if(v===undefined)throw new Error("Database parameter binding is missing.");return typeof v==="boolean"?(v?1:0):v};
function validateContract(contract:ScopedDatabaseContract, now:string):void {
  const names=new Set(contract.parameters.map(p=>p.name));
  if(names.size!==contract.parameters.length)throw new Error("Database parameter names must be unique.");
  if(contract.connection.actionIdentity===contract.connection.observerIdentity)throw new Error("Action and observer identities must be distinct.");
  if(contract.connection.status!=="active"||Date.parse(now)<Date.parse(contract.connection.notBefore)||Date.parse(now)>=Date.parse(contract.connection.expiresAt))throw new Error("Database connection profile is revoked, expired or inactive.");
  const statement=contract.transaction.statements[0]!; const scope=contract.allowlist.find(x=>x.table===statement.table);
  if(!scope)throw new Error("Database table is outside the exact allowlist.");
  const bindings=statement.kind==="insert"?statement.values:statement.kind==="update"?[...statement.set,...statement.where]:statement.where;
  if(bindings.some(x=>!scope.columns.includes(x.column)||!names.has(x.parameter)))throw new Error("Database column or parameter is outside the exact allowlist.");
  if(statement.kind!=="insert"&&(!statement.where.every(x=>scope.rowScopeColumns.includes(x.column))||!scope.rowScopeColumns.every(x=>statement.where.some(y=>y.column===x))))throw new Error("Database row scope is incomplete or widened.");
  if(!statement.conflictColumns.every(x=>scope.rowScopeColumns.includes(x)))throw new Error("Database conflict keys are not exact row-scope keys.");
  const privilege=`${statement.kind}:${statement.table}`;
  if(!contract.connection.actionPrivileges.includes(privilege)||contract.connection.observerPrivileges.some(x=>!x.startsWith("select:"))||!contract.connection.observerPrivileges.includes(`select:${statement.table}`))throw new Error("Database least-privilege profile does not match the transaction.");
}
function validateParameters(contract:ScopedDatabaseContract, raw:unknown):Record<string,string|number|boolean>{
  if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Database parameters must be an object.");
  const value=raw as Record<string,unknown>; const expected=new Set(contract.parameters.map(p=>p.name));
  if(Object.keys(value).length!==expected.size||Object.keys(value).some(x=>!expected.has(x)))throw new Error("Database parameters are missing, extra or ambiguous.");
  const result:Record<string,string|number|boolean>={};
  for(const p of contract.parameters){const v=value[p.name];if(p.type==="string"?typeof v!=="string":p.type==="integer"?!Number.isInteger(v):typeof v!=="boolean")throw new Error(`Database parameter ${p.name} has the wrong type.`);if(typeof v==="number"&&((p.min!==undefined&&v<p.min)||(p.max!==undefined&&v>p.max)))throw new Error(`Database parameter ${p.name} is outside bounds.`);result[p.name]=v as string|number|boolean}
  return result;
}
export function createScopedDatabaseProposal(input:{tenantId:string;parentGoalId:string;planId:string;planDigest:string;workItemId:string;contract:ScopedDatabaseContract;parameters:unknown;observedSchemaDigest:string;observedMigrationVersion:string;credentialAvailable:boolean;now:string}):ScopedDatabaseProposal{
  const contract=scopedDatabaseContractSchema.parse(input.contract);validateContract(contract,input.now);
  if(!input.credentialAvailable)throw new Error("Database action credential is unavailable.");
  if(input.tenantId!==contract.tenantId)throw new Error("Database contract belongs to another tenant.");
  if(input.observedSchemaDigest!==contract.schemaDigest)throw new Error("Database schema drift detected.");
  if(input.observedMigrationVersion!==contract.migrationVersion)throw new Error("Database migration version mismatch.");
  const parameters=validateParameters(contract,input.parameters);const contractDigest=composedRecoveryDigest(contract);const parameterDigest=composedRecoveryDigest(parameters);const transactionDigest=composedRecoveryDigest(contract.transaction);
  const capabilityMaterialDigest=composedRecoveryDigest({documentationDigest:contractDigest,schemaDigest:contract.schemaDigest,provenanceDigest:transactionDigest});
  const unsigned={schemaVersion:"1.0" as const,proposalId:"",tenantId:input.tenantId,parentGoalId:input.parentGoalId,planId:input.planId,planDigest:input.planDigest,workItemId:input.workItemId,contractId:contract.contractId,contractVersion:contract.contractVersion,contractDigest,schemaDigest:contract.schemaDigest,migrationVersion:contract.migrationVersion,targetAlias:contract.targetAlias,parameters,parameterDigest,transactionDigest,capabilityMaterialDigest,approvalKey:contract.approvalKey,workflowKey:contract.workflowKey,proposedAt:input.now};unsigned.proposalId=`scoped-db.${composedRecoveryDigest(unsigned).slice(0,40)}`;return{...unsigned,proposalDigest:composedRecoveryDigest(unsigned)};
}

export class ScopedDatabaseRuntime {
  private action:DatabaseSync;private observerState:"available"|"unknown"|"unavailable"="available";private protectedDigest:string;
  constructor(private readonly path:string,readonly actionIdentity:string,readonly observerIdentity:string,private readonly now:()=>string){mkdirSync(dirname(path),{recursive:true,mode:0o700});this.action=new DatabaseSync(path);chmodSync(path,0o600);this.action.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS inventory_items(sku TEXT PRIMARY KEY,on_hand INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS restock_drafts(operation_key TEXT,sku TEXT,quantity INTEGER,status TEXT);CREATE TABLE IF NOT EXISTS support_tickets(ticket_id TEXT PRIMARY KEY,assignee TEXT,status TEXT,version INTEGER);CREATE TABLE IF NOT EXISTS cf_operation_ledger(idempotency_key TEXT PRIMARY KEY,operation_key TEXT);CREATE TABLE IF NOT EXISTS protected_audit(audit_key TEXT PRIMARY KEY,audit_value TEXT);INSERT OR IGNORE INTO inventory_items VALUES('widget_one',2);INSERT OR IGNORE INTO support_tickets VALUES('ticket_100','queue','open',1);INSERT OR IGNORE INTO protected_audit VALUES('currency','GBP');`);this.protectedDigest=this.readProtected()}
  setObserverState(v:"available"|"unknown"|"unavailable"){this.observerState=v}
  reconcile(operationKey:string):"completed"|"not-started"|"unknown"{if(this.observerState!=="available")return"unknown";return this.action.prepare("SELECT 1 FROM cf_operation_ledger WHERE operation_key=?").get(operationKey)?"completed":"not-started"}
  execute(input:{proposal:ScopedDatabaseProposal;contract:ScopedDatabaseContract;authority:ScopedDatabaseAuthority;operationKey:string;idempotencyKey:string;fault?:"busy"|"deadlock"|"timeout"|"lost-response"}):{statements:number;writes:number;reused:boolean}{const{proposalDigest,...u}=input.proposal;if(composedRecoveryDigest(u)!==proposalDigest)throw new Error("Database proposal integrity failed.");for(const[a,b]of[[input.authority.tenantId,input.proposal.tenantId],[input.authority.parentGoalId,input.proposal.parentGoalId],[input.authority.planDigest,input.proposal.planDigest],[input.authority.workItemId,input.proposal.workItemId],[input.authority.targetAlias,input.proposal.targetAlias],[input.authority.approvalKey,input.proposal.approvalKey]])if(a!==b)throw new Error("Database authority binding changed.");if(input.authority.revoked||Date.parse(input.authority.expiresAt)<=Date.parse(this.now()))throw new Error("Database authority is revoked or expired.");if(this.action.prepare("SELECT 1 FROM cf_operation_ledger WHERE idempotency_key=?").get(input.idempotencyKey))return{statements:0,writes:0,reused:true};if(input.fault&&input.fault!=="lost-response")throw new Error(`Simulated ${input.fault} before transaction.`);const s=input.contract.transaction.statements[0]!;const params=input.proposal.parameters;this.action.exec("BEGIN IMMEDIATE");try{let info:{changes:bigint|number};if(s.kind==="insert"){const cols=s.values.map(x=>quote(x.column));info=this.action.prepare(`INSERT INTO ${quote(s.table)} (${["operation_key",...cols].join(",")}) VALUES (${["?",...cols.map(()=>"?")].join(",")})`).run(input.operationKey,...s.values.map(x=>sqlValue(params[x.parameter])))}else if(s.kind==="update"){info=this.action.prepare(`UPDATE ${quote(s.table)} SET ${s.set.map(x=>`${quote(x.column)}=?`).join(",")} WHERE ${s.where.map(x=>`${quote(x.column)}=?`).join(" AND ")}`).run(...s.set.map(x=>sqlValue(params[x.parameter])),...s.where.map(x=>sqlValue(params[x.parameter])))}else{info=this.action.prepare(`DELETE FROM ${quote(s.table)} WHERE ${s.where.map(x=>`${quote(x.column)}=?`).join(" AND ")}`).run(...s.where.map(x=>sqlValue(params[x.parameter])))}if(Number(info.changes)!==s.expectedRows)throw new Error("Database affected-row limit or conflict check failed.");this.action.prepare("INSERT INTO cf_operation_ledger VALUES(?,?)").run(input.idempotencyKey,input.operationKey);this.action.exec("COMMIT")}catch(e){if(this.action.isTransaction)this.action.exec("ROLLBACK");throw e}if(input.fault==="lost-response")throw new Error("Database response lost after commit.");return{statements:1,writes:1,reused:false}}
  observe(input:{contract:ScopedDatabaseContract;proposal:ScopedDatabaseProposal;operationKey:string;expected:Record<string,string|number|boolean>}):{classification:DatabaseObservationClass;evidenceDigest:string;incorrectSideEffects:number}{if(this.observerState!=="available")return{classification:this.observerState,evidenceDigest:composedRecoveryDigest({state:this.observerState,input}),incorrectSideEffects:0};if(this.actionIdentity===this.observerIdentity)throw new Error("Database observer identity is not independent.");const db=new DatabaseSync(this.path,{readOnly:true});try{const s=input.contract.transaction.statements[0]!;let rows:Record<string,unknown>[];if(s.kind==="insert")rows=db.prepare(`SELECT * FROM ${quote(s.table)} WHERE operation_key=?`).all(input.operationKey) as Record<string,unknown>[];else rows=db.prepare(`SELECT * FROM ${quote(s.table)} WHERE ${s.where.map(x=>`${quote(x.column)}=?`).join(" AND ")}`).all(...s.where.map(x=>sqlValue(input.proposal.parameters[x.parameter]))) as Record<string,unknown>[];const ledgerCount=(db.prepare("SELECT COUNT(*) AS value FROM cf_operation_ledger WHERE operation_key=?").get(input.operationKey) as {value:number}).value;const protectedChanged=this.readProtected(db)!==this.protectedDigest;const expectedEntries=Object.entries(input.expected);const exact=rows.filter(r=>expectedEntries.every(([k,v])=>r[k]===v));const matched=rows[0]?expectedEntries.filter(([k,v])=>rows[0]?.[k]===v).length:0;let classification:DatabaseObservationClass;if(protectedChanged)classification="collateral";else if(rows.length>1||ledgerCount>1)classification="duplicate";else if(s.kind!=="insert"&&ledgerCount===0)classification="not-started";else if(!rows.length)classification="not-started";else if(exact.length===1)classification="completed";else classification=matched>=expectedEntries.length-1?"partial":"incorrect";return{classification,evidenceDigest:composedRecoveryDigest({rows,ledgerCount,protectedChanged,input}),incorrectSideEffects:["incorrect","duplicate","collateral"].includes(classification)?1:0}}finally{db.close()}}
  inject(contract:ScopedDatabaseContract,proposal:ScopedDatabaseProposal,operationKey:string,kind:"partial"|"incorrect"|"duplicate"|"collateral"){const s=contract.transaction.statements[0]!;if(s.kind==="insert"){const base:[string,string|number,string|number,string]=[operationKey,sqlValue(proposal.parameters.sku??"widget_one"),sqlValue(proposal.parameters.quantity??1),"draft"];if(kind==="partial")base[2]=0;if(kind==="incorrect"){base[1]="wrong";base[2]=-1;base[3]="wrong"}this.action.prepare("INSERT INTO restock_drafts VALUES(?,?,?,?)").run(...base);if(kind==="duplicate")this.action.prepare("INSERT INTO restock_drafts VALUES(?,?,?,?)").run(...base)}else{if(kind==="partial")this.action.prepare("UPDATE support_tickets SET assignee=? WHERE ticket_id=?").run(sqlValue(proposal.parameters.assignee),sqlValue(proposal.parameters.ticket_id));if(kind==="incorrect")this.action.prepare("UPDATE support_tickets SET assignee='wrong',status='wrong' WHERE ticket_id=?").run(sqlValue(proposal.parameters.ticket_id));if(kind==="duplicate"){this.action.prepare("UPDATE support_tickets SET assignee=?,status=?,version=? WHERE ticket_id=?").run(sqlValue(proposal.parameters.assignee),sqlValue(proposal.parameters.status),sqlValue(proposal.parameters.expected_version),sqlValue(proposal.parameters.ticket_id));this.action.prepare("INSERT INTO cf_operation_ledger VALUES(?,?)").run(`${operationKey}-a`,operationKey);this.action.prepare("INSERT INTO cf_operation_ledger VALUES(?,?)").run(`${operationKey}-b`,operationKey)}else this.action.prepare("INSERT INTO cf_operation_ledger VALUES(?,?)").run(`${operationKey}-observed`,operationKey)}if(kind==="collateral"){this.action.prepare("UPDATE protected_audit SET audit_value='USD'").run();if(s.kind==="update")this.action.prepare("UPDATE support_tickets SET assignee=?,status=?,version=? WHERE ticket_id=?").run(sqlValue(proposal.parameters.assignee),sqlValue(proposal.parameters.status),sqlValue(proposal.parameters.expected_version),sqlValue(proposal.parameters.ticket_id))}}
  close(){this.action.close()}
  private readProtected(db=this.action){return sha(JSON.stringify(db.prepare("SELECT * FROM protected_audit ORDER BY audit_key").all()))}
}
