// ONE GOAL, MANY HANDS (one-goal-many-hands-v1) — the trusted goal scope.
//
// This file declares the NEW trusted scope for the V4 demo: one ordinary
// order-intake goal whose required coverage spans three capability families —
// the signed-message accept leg, the document capture leg, and the database
// record leg — with the trusted dependency chain notice → document → database
// (which contains the required document → database edge: the ledger leg may
// only run after the paper order is captured and verified).
//
// The scope is DATA consumed by the untouched trusted planning machinery
// (src/product/goal-coordination.ts). Nothing here widens authority: the
// planner proposal is validated by the GoalPlanCompiler's full trusted checks
// against exactly this scope, and authority comes from the envelope below,
// never from model output.
//
// BOUNDARY: this file only imports types/constants. It modifies nothing in
// src/product/, src/experimental/, or validation/.

import {
  GOAL_COORDINATION_SCHEMA_VERSION,
  type GoalPlanProposal,
  type TrustedGoalScope,
  type ValidatedGoalPlan,
  goalPlanProposalSchema,
} from "../product/goal-coordination.js";
import { FICTIONAL_INBOX_VERIFIER } from "./inbox-order-world.js";
import { FICTIONAL_DOCUMENT_VERIFIER } from "./pdf-order-world.js";

export const ONE_GOAL_TENANT = "one-goal-many-hands-operator";
export const ONE_GOAL_DEADLINE_KEY = "todays-order-intake";

export const COVERAGE_SIGNED_NOTICE = "coverage-signed-notice";
export const COVERAGE_PAPER_DOCUMENT = "coverage-paper-document";
export const COVERAGE_LEDGER_RECORD = "coverage-ledger-record";

/** The only execution order the trusted dependency chain permits. */
export const ONE_GOAL_COVERAGE_ORDER = [
  COVERAGE_SIGNED_NOTICE,
  COVERAGE_PAPER_DOCUMENT,
  COVERAGE_LEDGER_RECORD,
] as const;

/** Matches DB_TRUSTED.outcomeVerifierKey in run-one-goal-many-hands.ts. */
export const ONE_GOAL_LEDGER_VERIFIER = "independent-restock-reader";

export function createOneGoalTrustedScope(
  parentGoalId: string,
  requestId: string,
  ordinaryGoal: string,
): TrustedGoalScope {
  return {
    tenantId: ONE_GOAL_TENANT,
    parentGoalId,
    requestId,
    ordinaryGoal,
    deadline: {
      key: ONE_GOAL_DEADLINE_KEY,
      description: "Today's fictional order-intake window in the fictional local business timezone.",
    },
    entities: [
      { alias: "order_notice", kind: "signed-order-notice", systemAliases: ["signed_message_ingress"] },
      { alias: "paper_order", kind: "paper-purchase-order", systemAliases: ["document_archive"] },
      { alias: "order_ledger", kind: "restock-ledger", systemAliases: ["ledger_database"] },
    ],
    systems: [
      {
        targetAlias: "signed_message_ingress",
        credentialAliases: ["signed_message_ingress_key"],
        operations: [
          { name: "accept_signed_notice", method: "POST", requiredCompanionActions: ["verify_notice_draft"] },
          { name: "verify_notice_draft", method: "GET" },
        ],
      },
      {
        targetAlias: "document_archive",
        credentialAliases: ["document_archive_key"],
        operations: [
          { name: "capture_paper_order", method: "POST", requiredCompanionActions: ["verify_paper_draft"] },
          { name: "verify_paper_draft", method: "GET" },
        ],
      },
      {
        targetAlias: "ledger_database",
        credentialAliases: ["ledger_database_key"],
        operations: [
          { name: "record_ledger_rows", method: "POST", requiredCompanionActions: ["verify_ledger_rows"] },
          { name: "verify_ledger_rows", method: "GET" },
        ],
      },
    ],
    completionCriteria: [
      {
        key: "notice-accepted-and-verified",
        summary: "The signed order notice was accepted over verified HMAC ingress and its draft passed the independent inbox verifier.",
        verifierKey: FICTIONAL_INBOX_VERIFIER,
      },
      {
        key: "paper-captured-and-verified",
        summary: "The referenced pinned paper purchase order was parsed and its draft passed the independent customer-side document verifier.",
        verifierKey: FICTIONAL_DOCUMENT_VERIFIER,
      },
      {
        key: "ledger-recorded-and-verified",
        summary: "Every independently verified parsed order line exists as exactly one reviewed ledger row, proven by an independent read-only connection.",
        verifierKey: ONE_GOAL_LEDGER_VERIFIER,
      },
    ],
    requiredCoverage: [
      {
        key: COVERAGE_SIGNED_NOTICE,
        entityAliases: ["order_notice"],
        workflowKey: "accept-order-notice",
        requiredActions: ["accept_signed_notice", "verify_notice_draft"],
        targetAliases: ["signed_message_ingress"],
        completionCriterionKeys: ["notice-accepted-and-verified"],
      },
      {
        key: COVERAGE_PAPER_DOCUMENT,
        entityAliases: ["paper_order"],
        workflowKey: "capture-paper-order",
        requiredActions: ["capture_paper_order", "verify_paper_draft"],
        targetAliases: ["document_archive"],
        completionCriterionKeys: ["paper-captured-and-verified"],
        dependsOnCoverageKeys: [COVERAGE_SIGNED_NOTICE],
      },
      {
        // The required document → database dependency edge lives here: the
        // ledger leg is only logically safe after the paper capture verified.
        key: COVERAGE_LEDGER_RECORD,
        entityAliases: ["order_ledger"],
        workflowKey: "record-order-ledger",
        requiredActions: ["record_ledger_rows", "verify_ledger_rows"],
        targetAliases: ["ledger_database"],
        completionCriterionKeys: ["ledger-recorded-and-verified"],
        dependsOnCoverageKeys: [COVERAGE_PAPER_DOCUMENT],
      },
    ],
    authority: {
      allowedTargetAliases: ["signed_message_ingress", "document_archive", "ledger_database"],
      allowedSecretAliases: ["signed_message_ingress_key", "document_archive_key", "ledger_database_key"],
      allowedMethods: ["GET", "POST"],
      writeAuthority: "per-action-approval",
      approvedWriteActions: ["accept_signed_notice", "capture_paper_order", "record_ledger_rows"],
    },
  };
}

/**
 * The deterministic reference proposal used by the FREE dry run. It goes
 * through the SAME GoalPlanCompiler trusted validation as a model proposal —
 * nothing about the validation path is stubbed.
 */
export function referenceOneGoalPlanProposal(): GoalPlanProposal {
  return goalPlanProposalSchema.parse({
    schemaVersion: GOAL_COORDINATION_SCHEMA_VERSION,
    deadlineKey: ONE_GOAL_DEADLINE_KEY,
    summary:
      "Accept the signed order notice first, capture and verify the paper purchase order it references, and only then record each verified line in the ledger — refusing anything unverified.",
    workItems: [
      {
        key: "accept-signed-notice",
        groupKey: "todays-order-intake",
        groupLabel: "Today's fictional order intake",
        summary: "Accept the signed webhook order notice over verified ingress and independently verify the resulting draft.",
        coverageKeys: [COVERAGE_SIGNED_NOTICE],
        entityAliases: ["order_notice"],
        workflowKey: "accept-order-notice",
        requiredActions: ["accept_signed_notice", "verify_notice_draft"],
        targetAliases: ["signed_message_ingress"],
        completionCriterionKeys: ["notice-accepted-and-verified"],
        dependsOnKeys: [],
      },
      {
        key: "capture-paper-order",
        groupKey: "todays-order-intake",
        groupLabel: "Today's fictional order intake",
        summary: "Capture the pinned paper purchase order the verified notice references and independently verify the parsed draft.",
        coverageKeys: [COVERAGE_PAPER_DOCUMENT],
        entityAliases: ["paper_order"],
        workflowKey: "capture-paper-order",
        requiredActions: ["capture_paper_order", "verify_paper_draft"],
        targetAliases: ["document_archive"],
        completionCriterionKeys: ["paper-captured-and-verified"],
        dependsOnKeys: ["accept-signed-notice"],
      },
      {
        key: "record-order-ledger",
        groupKey: "todays-order-intake",
        groupLabel: "Today's fictional order intake",
        summary: "Record each independently verified parsed order line as exactly one reviewed ledger row, idempotently.",
        coverageKeys: [COVERAGE_LEDGER_RECORD],
        entityAliases: ["order_ledger"],
        workflowKey: "record-order-ledger",
        requiredActions: ["record_ledger_rows", "verify_ledger_rows"],
        targetAliases: ["ledger_database"],
        completionCriterionKeys: ["ledger-recorded-and-verified"],
        dependsOnKeys: ["capture-paper-order"],
      },
    ],
  });
}

/**
 * Trusted reconstruction of a plan proposal from a previously VALIDATED plan,
 * for the retained-plan reuse phase: the reconstructed proposal is re-validated
 * from scratch by the same GoalPlanCompiler against the second goal's scope.
 */
export function proposalFromValidatedPlan(plan: ValidatedGoalPlan): GoalPlanProposal {
  const keyById = new Map(plan.workItems.map((item) => [item.workItemId, item.key]));
  return goalPlanProposalSchema.parse({
    schemaVersion: plan.schemaVersion,
    deadlineKey: plan.deadline.key,
    summary: plan.summary,
    workItems: [...plan.workItems]
      .sort((left, right) => left.executionOrder - right.executionOrder)
      .map((item) => ({
        key: item.key,
        groupKey: item.groupKey,
        groupLabel: item.groupLabel,
        summary: item.summary,
        coverageKeys: [...item.coverageKeys],
        entityAliases: [...item.entityAliases],
        workflowKey: item.workflowKey,
        requiredActions: [...item.requiredActions],
        targetAliases: [...item.targetAliases],
        completionCriterionKeys: item.completionCriteria.map((criterion) => criterion.key),
        dependsOnKeys: item.dependencyWorkItemIds.map((id) => {
          const key = keyById.get(id);
          if (!key) throw new Error("Retained plan reconstruction found an unknown dependency work item id.");
          return key;
        }),
      })),
  });
}
