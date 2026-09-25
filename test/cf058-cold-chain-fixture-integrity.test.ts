import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  Cf053ContentAddressedCandidateRegistry,
  deriveCf053ProviderNeutralContract,
} from "../src/product/local-declarative-exact-record-core.js";
import { compileSdkSemanticContract } from "../src/product/customer-local-sdk-semantic-compiler.js";
import { sdkWorkPackDigest } from "../src/product/customer-local-sdk-work-pack.js";
import {
  CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
  CF058_COLD_CHAIN_ACTION_DRIVER,
  CF058_COLD_CHAIN_ACTION_OPERATION,
  CF058_COLD_CHAIN_ACTION_PATH,
  CF058_COLD_CHAIN_OBSERVER_SERVER_URL,
  CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
  CF058_COLD_CHAIN_OBSERVER_DRIVER,
  CF058_COLD_CHAIN_OBSERVER_OPERATION,
  CF058_COLD_CHAIN_OBSERVER_PATH,
  CF058_COLD_CHAIN_SERVER_URL,
  CF058_COLD_CHAIN_TARGET_ALIAS,
  cf058ColdChainReviewedSource,
} from "./fixtures/cf058-cold-chain-reviewed-source.js";
import {
  createCf058ColdChainProductionDerivationFixture,
  cf058ColdChainUpstream,
} from "./fixtures/cf058-cold-chain-upstream.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("CF-058 fresh cold-chain source fixtures", () => {
  it("pins a reviewed PUT action and independently authenticated GET observer without granting execution", () => {
    const reviewed = cf058ColdChainReviewedSource();
    expect(reviewed.normalization).toMatchObject({
      status: "review-required",
      executable: false,
      confirmedServerUrl: CF058_COLD_CHAIN_SERVER_URL,
      targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
      blockers: [],
    });
    expect(reviewed.normalization.operations.map((operation) => [operation.operationId, operation.method, operation.path])).toEqual([
      ["readQuarantineDirective", "GET", CF058_COLD_CHAIN_ACTION_PATH],
      ["probeQuarantineDirective", "HEAD", CF058_COLD_CHAIN_ACTION_PATH],
      ["putQuarantineDirective", "PUT", CF058_COLD_CHAIN_ACTION_PATH],
    ]);
    expect(reviewed.observerNormalization).toMatchObject({
      status: "review-required",
      executable: false,
      confirmedServerUrl: CF058_COLD_CHAIN_OBSERVER_SERVER_URL,
      targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
      blockers: [],
    });
    expect(reviewed.observerNormalization.operations.map((operation) => [operation.operationId, operation.method, operation.path])).toEqual([
      ["auditQuarantineDirective", "GET", CF058_COLD_CHAIN_OBSERVER_PATH],
    ]);
    expect(reviewed.authorityCompilation).toMatchObject({
      status: "review-required",
      activation: "not-activated",
      candidateAuthority: {
        allowedSecretAliases: expect.arrayContaining([
          CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
          CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
        ]),
      },
    });
    expect(reviewed.authorityAnswers.limits.quantityPerAction).toEqual({
      kind: "limit",
      maximum: 500,
      confirmed: true,
    });
    expect(reviewed.factoryResult).toMatchObject({
      status: "review-required",
      executable: false,
      qualified: false,
      activated: false,
      blockers: [],
      actionBinding: {
        driverId: CF058_COLD_CHAIN_ACTION_DRIVER,
        operation: { operationId: CF058_COLD_CHAIN_ACTION_OPERATION, method: "PUT", pathTemplate: CF058_COLD_CHAIN_ACTION_PATH },
        credentialAlias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS,
      },
      observerBinding: {
        driverId: CF058_COLD_CHAIN_OBSERVER_DRIVER,
        serverUrl: CF058_COLD_CHAIN_OBSERVER_SERVER_URL,
        operation: { operationId: CF058_COLD_CHAIN_OBSERVER_OPERATION, method: "GET", pathTemplate: CF058_COLD_CHAIN_OBSERVER_PATH },
        credentialAlias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS,
        actionResponseEligibleAsProof: false,
      },
    });
    expect(reviewed.factoryResult.actionBinding!.driverId).not.toBe(reviewed.factoryResult.observerBinding!.driverId);
    expect(reviewed.factoryResult.actionBinding!.credentialAlias).not.toBe(reviewed.factoryResult.observerBinding!.credentialAlias);
    expect(reviewed.factoryResult.actionBinding!.requestMappings.map((mapping) => mapping.source.kind === "workflow-input" ? mapping.source.inputKey : "trusted-context").sort()).toEqual([
      "directive_ref",
      "hold_quantity",
      "lot_code",
      "reason_confirmed",
    ]);
  });

  it("binds CF-036 and CF-041 to the exact reviewed HTTP factory result", () => {
    const reviewed = cf058ColdChainReviewedSource();
    const upstream = cf058ColdChainUpstream(reviewed);
    const { workPackDigest, ...workPackBody } = upstream.workPack;
    expect(workPackDigest).toBe(sdkWorkPackDigest(workPackBody));
    expect(upstream.workPack.factoryResultDigest).toBe(reviewed.factoryResult.resultDigest);
    expect(upstream.workPack.roles.map((role) => [role.review.role, role.method.methodName])).toEqual([
      ["action", "putQuarantineDirective"],
      ["no-write-probe", "probeQuarantineDirective"],
      ["reconciliation-readback", "readQuarantineDirective"],
      ["independent-observer", "auditQuarantineDirective"],
    ]);
    expect(upstream.contract.credentials).toMatchObject({
      action: { alias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS, exactScope: `PUT ${CF058_COLD_CHAIN_ACTION_PATH}` },
      observer: { alias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS, exactScope: `GET ${CF058_COLD_CHAIN_OBSERVER_PATH}` },
    });
    expect(upstream.contract.idempotency).toMatchObject({
      reconcileBeforeRetry: true,
      blindRetryAllowed: false,
    });
    expect(upstream.contract.stableIdentity.expression.key).toBe("directive_ref");
    expect(new Set(upstream.contract.outcome.predicates.map((predicate) => predicate.inputKey))).toEqual(new Set([
      "directive_ref",
      "lot_code",
      "hold_quantity",
      "reason_confirmed",
    ]));
    expect(() => compileSdkSemanticContract({
      contract: upstream.contract,
      workPack: upstream.workPack,
      now: "2026-08-14T11:30:00.000Z",
    })).not.toThrow();
  });

  it("materializes the coordinated CF-051 source and derives one production CF-053 candidate handle without executing it", () => {
    const root = mkdtempSync(join(tmpdir(), "cf058-cold-chain-source-"));
    roots.push(root);
    const fixture = createCf058ColdChainProductionDerivationFixture(root);
    try {
      const derived = deriveCf053ProviderNeutralContract({
        board: fixture.board,
        coordinator: fixture.coordinator,
        reader: fixture.reader,
        boardId: fixture.boardId,
        tenantId: fixture.tenantId,
        trustedDeployment: {
          tenantId: fixture.tenantId,
          targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
          policyVersion: "cf058_cold_chain_policy_v1",
          workspaceTrustRootDirectory: join(root, "workspace-trust"),
        },
      });
      expect(derived.contractDigest).toMatch(/^[a-f0-9]{64}$/);
      const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "candidate-registry"));
      const candidate = registry.acquire(derived, "2026-08-14T11:40:00.000Z");
      expect(candidate).toMatchObject({ source: "built", candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/) });
      const retained = registry.acquire(derived, "2026-08-14T11:41:00.000Z");
      expect(retained).toMatchObject({ source: "retained", candidateDigest: candidate.candidateDigest });
    } finally {
      fixture.close();
    }
  });
});
