import { describe, expect, it } from "vitest";
import {
  assertCustomerLocalQualificationCurrent,
  bindingQualificationDigest,
  createLocalFixtureBindingQualification,
  qualifyCustomerLocalBindings,
} from "../src/product/customer-local-binding-qualification.js";
import { compileReviewedHttpBindings } from "../src/product/http-binding-compiler.js";
import { readinessTestBindingArtifacts, readinessTestPreparation, readinessTestStartInput } from "./product-onboarding-readiness-receipt.test.js";

function fixture(suffix: string) {
  const intake = readinessTestStartInput();
  intake.sessionId = `northstar-${suffix}`;
  const prepared = readinessTestPreparation(intake);
  const built = readinessTestBindingArtifacts(prepared);
  const qualification = createLocalFixtureBindingQualification({
    tenantId: intake.tenantId,
    sessionId: intake.sessionId,
    packageDigest: prepared.inputDigest,
    sourceDigest: built.normalization.normalizedMaterialDigest,
    factoryResult: built.factoryResult,
    actionTransport: built.runtime.actionTransport,
    observerTransport: built.runtime.observerTransport,
    credentialResolver: built.runtime.credentialResolver,
    qualifiedAt: "2026-08-14T11:00:00.000Z",
    expiresAt: "2026-09-13T11:00:00.000Z",
  });
  const expected = { tenantId: intake.tenantId, sessionId: intake.sessionId, packageDigest: prepared.inputDigest, factoryResultDigest: built.factoryResult.resultDigest, sourceDigest: built.normalization.normalizedMaterialDigest, now: "2026-08-14T12:00:00.000Z" };
  return { intake, prepared, built, qualification, expected };
}

function requalify(f: ReturnType<typeof fixture>) {
  return qualifyCustomerLocalBindings({
    tenantId: f.intake.tenantId,
    sessionId: f.intake.sessionId,
    packageDigest: f.prepared.inputDigest,
    sourceDigest: f.built.normalization.normalizedMaterialDigest,
    factoryResult: f.built.factoryResult,
    actionTransport: f.built.runtime.actionTransport,
    observerTransport: f.built.runtime.observerTransport,
    credentialResolver: f.built.runtime.credentialResolver,
    runtime: f.qualification.runtime,
    qualifiedAt: "2026-08-14T11:00:00.000Z",
    expiresAt: "2026-09-13T11:00:00.000Z",
  });
}

describe("customer-local credential and split-transport qualification", () => {
  it("qualifies two isolated network-shaped worlds without secrets or authority", () => {
    for (const suffix of ["loopback-alpha", "loopback-beta"]) {
      const f = fixture(suffix);
      assertCustomerLocalQualificationCurrent(f.qualification.receipt, f.qualification.runtime, f.expected);
      expect(f.qualification.receipt).toMatchObject({ state: "qualified-for-acceptance-compilation", tenantId: "northstar-tenant", sessionId: `northstar-${suffix}`, executionAuthorityEffect: "none", activationEffect: "none" });
      expect(JSON.stringify(f.qualification.receipt)).not.toContain("opaque-customer-local-handle");
      expect(f.qualification.receipt.credentials.action.alias).not.toBe(f.qualification.receipt.credentials.observer.alias);
      expect(f.qualification.receipt.transports.action.implementationDigest).not.toBe(f.qualification.receipt.transports.observer.implementationDigest);
    }
  });

  it("rejects missing, shared, wrongly scoped, revoked and stale opaque bindings", () => {
    const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
      (f) => f.qualification.bindings.delete(f.built.factoryResult.actionBinding!.credentialAlias),
      (f) => { const action = f.qualification.bindings.get(f.built.factoryResult.actionBinding!.credentialAlias)!; const observer = f.qualification.bindings.get(f.built.factoryResult.observerBinding!.credentialAlias)!; observer.handleDigest = action.handleDigest; },
      (f) => { f.qualification.bindings.get(f.built.factoryResult.actionBinding!.credentialAlias)!.scopes = ["GET /wrong"]; },
      (f) => { f.qualification.bindings.get(f.built.factoryResult.observerBinding!.credentialAlias)!.revoked = true; },
      (f) => { f.qualification.bindings.get(f.built.factoryResult.actionBinding!.credentialAlias)!.expiresAt = "2026-08-14T10:00:00.000Z"; },
    ];
    for (const mutate of cases) { const f = fixture(bindingQualificationDigest(String(cases.indexOf(mutate))).slice(0, 8)); mutate(f); expect(() => requalify(f)).toThrow(); }
  });

  it("rejects schema drift, TLS-policy mismatch, unavailable/misrouted transport and source drift", () => {
    const schema = fixture("schema-drift");
    schema.qualification.runtime.actionProfile.requestSchemaDigest = bindingQualificationDigest("wrong schema");
    expect(() => requalify(schema)).toThrow(/schema/i);

    const tls = fixture("tls-policy");
    tls.qualification.runtime.observerProfile.tlsPolicy = "https-required";
    tls.qualification.runtime.observerProfile.serverUrl = "http://northstar.local.invalid/v1";
    expect(() => requalify(tls)).toThrow(/endpoint|HTTPS/i);

    const unavailable = fixture("unavailable");
    unavailable.qualification.runtime.probeTransport = () => ({ reachable: false, endpointDigest: bindingQualificationDigest("unavailable"), checkedAt: "2026-08-14T11:00:00.000Z" });
    expect(() => requalify(unavailable)).toThrow(/unavailable|misrouted/i);

    const source = fixture("source-drift");
    source.qualification.runtime.actionProfile.sourceDigest = bindingQualificationDigest("changed source");
    expect(() => requalify(source)).toThrow(/source-drifted/i);
  });

  it("invalidates a compiled receipt after credential rotation/revocation and across boundaries", () => {
    const rotated = fixture("rotated");
    rotated.qualification.bindings.get(rotated.built.factoryResult.actionBinding!.credentialAlias)!.revision += 1;
    expect(() => assertCustomerLocalQualificationCurrent(rotated.qualification.receipt, rotated.qualification.runtime, rotated.expected)).toThrow(/rotated|unrequalified/i);

    const revoked = fixture("revoked-after");
    revoked.qualification.bindings.get(revoked.built.factoryResult.observerBinding!.credentialAlias)!.revoked = true;
    expect(() => assertCustomerLocalQualificationCurrent(revoked.qualification.receipt, revoked.qualification.runtime, revoked.expected)).toThrow(/revoked/i);

    const crossed = fixture("crossed");
    expect(() => assertCustomerLocalQualificationCurrent(crossed.qualification.receipt, crossed.qualification.runtime, { ...crossed.expected, tenantId: "another-tenant" })).toThrow(/different tenant/i);
    expect(() => assertCustomerLocalQualificationCurrent(crossed.qualification.receipt, crossed.qualification.runtime, { ...crossed.expected, sessionId: "another-session" })).toThrow(/different tenant/i);
    expect(() => assertCustomerLocalQualificationCurrent(crossed.qualification.receipt, crossed.qualification.runtime, { ...crossed.expected, packageDigest: bindingQualificationDigest("another package") })).toThrow(/different tenant/i);
  });

  it("blocks an already compiled observer before transport work after credential rotation", async () => {
    const f = fixture("compiled-rotation");
    const pair = compileReviewedHttpBindings({
      factoryResult: f.built.factoryResult,
      actionTransport: f.built.runtime.actionTransport,
      observerTransport: f.built.runtime.observerTransport,
      credentialResolver: f.built.runtime.credentialResolver,
      primitiveRegistryDigest: f.built.runtime.primitiveRegistryDigest,
      verifierRegistryDigest: f.built.runtime.verifierRegistryDigest,
      qualifiedAt: "2026-08-14T11:00:00.000Z",
      expiresAt: "2026-09-13T11:00:00.000Z",
      customerLocalQualification: f.qualification,
      now: () => Date.parse("2026-08-14T12:00:00.000Z"),
    });
    f.qualification.bindings.get(f.built.factoryResult.observerBinding!.credentialAlias)!.revision += 1;
    await expect(pair.observer.observe({ requestId: "observe-rotation", parentGoalId: "goal-rotation", workItemId: "item-rotation", workflowInput: {}, trustedContext: {}, operationStartedAtEpochMs: Date.parse("2026-08-14T11:59:59.000Z") })).rejects.toThrow(/rotated|unrequalified/i);
  });
});
