import { randomUUID } from "node:crypto";

export type CapabilityStatus = "active" | "quarantined" | "revoked";
export interface AuthorityCapability {
  capabilityId: string; status: CapabilityStatus; origin: "built" | "reused" | "trusted-existing";
  documentationHash: string; actions: string[]; verifiedAt: string; verificationReceipt: string;
  version: number;
}

export interface PolicyVersion {
  policyId: string; version: number; name: string; status: "draft" | "validated" | "tested" | "active" | "superseded";
  allowedTargets: string[]; credentialAliases: string[]; methods: string[];
  writeAuthority: "denied" | "preauthorized" | "per-action-approval"; approvedActions: string[];
  validationChecks: string[]; acceptancePassed: boolean; createdAt: string;
}

export class LocalReferenceAuthority {
  private capabilities = new Map<string, AuthorityCapability>();
  private policies: PolicyVersion[] = [];
  readonly environments: Array<{
    environmentId: string; name: string; mode: string; runnerHealth: string; runnerVersion: string;
    verifierHealth: string; targetAliases: string[]; credentialAliases: Array<{ alias: string; available: boolean }>;
    acceptanceStatus: string; lastCheckedAt: string;
  }> = [{
    environmentId: "local-sidecar", name: "Local customer runner", mode: "customer-sidecar",
    runnerHealth: "healthy", runnerVersion: "reference-v1", verifierHealth: "ready",
    targetAliases: ["customer_erp", "fictional_erp"],
    credentialAliases: [{ alias: "erp_api_key", available: false }, { alias: "erp_sandbox_key", available: true }],
    acceptanceStatus: "not-run", lastCheckedAt: new Date().toISOString(),
  }];

  constructor() {
    this.capabilities.set("http-capability-dbe7c52651f32bfc9cf8", {
      capabilityId: "http-capability-dbe7c52651f32bfc9cf8", status: "active", origin: "built",
      documentationHash: "sha256:recorded-docs", actions: ["read_order", "find_delivery", "create_delivery", "update_order"],
      verifiedAt: "2026-07-26T10:14:13.000Z", verificationReceipt: "recorded-verification-receipt-01", version: 1,
    });
    this.policies.push({ policyId: "policy-local", version: 1, name: "Local sandbox — read only", status: "active",
      allowedTargets: ["fictional_erp"], credentialAliases: ["erp_sandbox_key"], methods: ["GET"],
      writeAuthority: "denied", approvedActions: [], validationChecks: ["aliases-only", "known-methods", "target-configured"],
      acceptancePassed: true, createdAt: new Date().toISOString() });
  }

  listCapabilities() { return [...this.capabilities.values()].map((item) => structuredClone(item)); }
  capabilityCommand(id: string, command: "quarantine" | "revoke", expectedVersion: number) {
    const item = this.capabilities.get(id);
    if (!item) throw new Error("Capability not found");
    if (item.version !== expectedVersion) throw new Error("Stale capability version");
    if (item.status === "revoked") throw new Error("Revoked capability cannot be changed");
    item.status = command === "revoke" ? "revoked" : "quarantined";
    item.version += 1;
    return structuredClone(item);
  }

  listPolicies() { return structuredClone(this.policies).sort((a, b) => b.version - a.version); }
  createPolicy(input: Omit<PolicyVersion, "policyId" | "version" | "status" | "validationChecks" | "acceptancePassed" | "createdAt">) {
    const version = Math.max(0, ...this.policies.map((policy) => policy.version)) + 1;
    const policy: PolicyVersion = { ...structuredClone(input), policyId: "policy-local", version, status: "draft", validationChecks: [], acceptancePassed: false, createdAt: new Date().toISOString() };
    this.policies.push(policy); return structuredClone(policy);
  }
  validatePolicy(version: number) {
    const policy = this.policy(version);
    if (policy.status !== "draft") throw new Error("Only a draft can be validated");
    if (!policy.allowedTargets.length || !policy.methods.length) throw new Error("Policy needs a target and method");
    if (policy.methods.some((method) => !["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))) throw new Error("Unknown HTTP method");
    if (policy.writeAuthority === "denied" && policy.methods.some((method) => method !== "GET")) throw new Error("Denied-write policy cannot include write methods");
    policy.validationChecks = ["target aliases configured", "credential aliases only", "HTTP methods recognized", "write authority internally consistent"];
    policy.status = "validated"; return structuredClone(policy);
  }
  testPolicy(version: number) {
    const policy = this.policy(version); if (policy.status !== "validated") throw new Error("Validate the unchanged draft before testing");
    policy.acceptancePassed = true; policy.status = "tested"; return structuredClone(policy);
  }
  activatePolicy(version: number) {
    const policy = this.policy(version); if (policy.status !== "tested" || !policy.acceptancePassed) throw new Error("Only an acceptance-tested policy can activate");
    for (const prior of this.policies) if (prior.status === "active") prior.status = "superseded";
    policy.status = "active"; return structuredClone(policy);
  }
  testEnvironment(id: string) {
    const environment = this.environments.find((item) => item.environmentId === id); if (!environment) throw new Error("Environment not found");
    environment.acceptanceStatus = "passed"; environment.lastCheckedAt = new Date().toISOString(); return structuredClone(environment);
  }
  private policy(version: number) { const value = this.policies.find((item) => item.version === version); if (!value) throw new Error("Policy version not found"); return value; }
}
