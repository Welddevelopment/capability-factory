import { createHmac, timingSafeEqual } from "node:crypto";
import type { CleanPackageAuthoringQuestion, CleanPackageAuthoringSnapshot } from "./onboarding-clean-package-authoring.js";
import { cleanPackageAuthoringDigest, validateCleanPackageAuthoringAnswer } from "./onboarding-clean-package-authoring.js";

export const ONBOARDING_DECISION_COACH_VERSION = "1.0" as const;

export interface CoachedQuestion {
  questionId: string;
  group: string;
  dependencyDepth: number;
  prerequisites: string[];
  state: "available" | "locked" | "answered";
  explanation: string;
  whyItMatters: string;
  safeExample: string;
  counterexample: string;
  source: { factKey: string; provenance: unknown[] };
  downstreamEffect: string;
  remainingBlockersAfterAnswer: number;
}

export interface DecisionCoachProjection {
  schemaVersion: typeof ONBOARDING_DECISION_COACH_VERSION;
  mode: "read-only-rehearsal";
  sessionId: string;
  revision: number;
  questions: CoachedQuestion[];
  availableQuestionIds: string[];
  maximumDependencyDepth: number;
  remainingHumanDecisions: number;
  dryRun: {
    mutation: false;
    executionAuthorityEffect: "none";
    activationEffect: "none";
    producedNow: string[];
    producedAfterAllExplicitConfirmations: string[];
    remainsBlocked: string[];
  };
}

export interface CoachAnswerAssessment {
  acceptedForSubmission: boolean;
  contradictions: string[];
  unsafeCombinations: string[];
  lowInformationAnswers: string[];
  sourceInconsistencies: string[];
  lockedQuestionIds: string[];
  projectedRemainingHumanDecisions: number;
  downstreamEffects: string[];
  mutation: false;
  executionAuthorityEffect: "none";
  activationEffect: "none";
}

const dependencies: Record<string, string[]> = {
  "stable-input-key": [], "conflict-input-key": ["stable-input-key"], "alternative-conflict-value": ["conflict-input-key"],
  "observer-query-input-key": ["stable-input-key", "observer-query-name"], "duplicate-key": ["stable-input-key"],
  "independent-observation": ["action-driver-id", "action-source-id", "observer-driver-id", "observer-source-id"],
  "observer-result-path": ["independent-observation"], "freshness-path": ["independent-observation"], "freshness-seconds": ["freshness-path"],
  "duplicate-count": ["duplicate-key", "observer-result-path"], "collateral-path": ["independent-observation"], "collateral-expected": ["collateral-path"],
  "reconcile-before-retry": ["independent-observation"], "blind-retry": ["reconcile-before-retry"], "maximum-attempts": ["reconcile-before-retry"],
  "write-policy": ["reconcile-before-retry", "independent-observation"], "quantity-limit": ["write-policy"], "rate-limit": ["write-policy"],
  "forbidden-actions": ["write-policy"], "approver-policy": ["write-policy"], "final-review": ["quantity-limit", "rate-limit", "forbidden-actions", "approver-policy", "blind-retry", "maximum-attempts"],
};

function prereqs(question: CleanPackageAuthoringQuestion): string[] {
  if (question.questionId.startsWith("mapping-")) return [`input-${question.questionId.slice(8)}`];
  return dependencies[question.questionId] ?? [];
}

function depth(id: string, seen = new Set<string>()): number {
  if (seen.has(id)) return 0;
  const next = dependencies[id] ?? (id.startsWith("mapping-") ? [`input-${id.slice(8)}`] : []);
  return next.length === 0 ? 0 : 1 + Math.max(...next.map((item) => depth(item, new Set([...seen, id]))));
}

function group(id: string): string {
  if (/driver|source/.test(id)) return "runtime-separation";
  if (/stable|conflict|input-|mapping-|query/.test(id)) return "identity-and-mapping";
  if (/independent|observer|freshness|duplicate|collateral/.test(id)) return "independent-proof";
  if (/retry|attempt/.test(id)) return "recovery";
  return "authority-and-limits";
}

function example(question: CleanPackageAuthoringQuestion): string {
  if (question.answerKind === "identifier") return "Format example only: customer_local_read_driver. Choose the real reviewed identifier; do not copy this value.";
  if (question.answerKind === "enum") return `Shape example only: choose one exact reviewed option shown by the source (${question.options?.map(String).join(", ")}).`;
  if (question.answerKind === "boolean") return "Answer true or false only after checking the stated boundary; the coach does not recommend either value.";
  if (question.answerKind === "integer") return "Enter the exact reviewed integer. A convenient number is not evidence.";
  if (question.answerKind === "empty-list") return "Use [] only if an authorized owner confirms there are no additional forbidden-action names for this bounded contract.";
  return "Enter one concrete bounded business value of the documented type; placeholders are rejected.";
}

function counterexample(question: CleanPackageAuthoringQuestion): string {
  if (/authority|write-policy|approver|limit|retry|independent/.test(`${question.questionId} ${question.factKey}`)) return "Unsafe: accepting a suggested/default value because it makes onboarding pass.";
  if (/driver|source/.test(question.questionId)) return "Unsafe: reusing the action implementation as its own independent observer.";
  return "Unsafe: TBD, example, test, any, unknown, or text copied from prompt-like source instructions.";
}

export function projectOnboardingDecisionCoach(snapshot: CleanPackageAuthoringSnapshot): DecisionCoachProjection {
  const answered = new Set(snapshot.questions.filter((item) => item.answerStatus === "customer-confirmed").map((item) => item.questionId));
  const remaining = snapshot.questions.filter((item) => !answered.has(item.questionId)).length;
  const questions = snapshot.questions.map((question): CoachedQuestion => {
    const required = prereqs(question);
    const state = answered.has(question.questionId) ? "answered" : required.every((item) => answered.has(item)) ? "available" : "locked";
    const fact = snapshot.facts.find((item) => item.questionId === question.questionId);
    return {
      questionId: question.questionId, group: group(question.questionId), dependencyDepth: depth(question.questionId), prerequisites: required, state,
      explanation: question.prompt, whyItMatters: question.consequence, safeExample: example(question), counterexample: counterexample(question),
      source: { factKey: question.factKey, provenance: fact?.provenance ?? [] },
      downstreamEffect: `Explicit confirmation changes ${question.factKey} from proposal/unknown to customer-confirmed in the next integrity-bound revision; it does not grant runtime authority.`,
      remainingBlockersAfterAnswer: state === "available" ? Math.max(0, remaining - 1) : remaining,
    };
  });
  return {
    schemaVersion: ONBOARDING_DECISION_COACH_VERSION, mode: "read-only-rehearsal", sessionId: snapshot.authoringSessionId, revision: snapshot.revision,
    questions, availableQuestionIds: questions.filter((item) => item.state === "available").map((item) => item.questionId), maximumDependencyDepth: Math.max(0, ...questions.map((item) => item.dependencyDepth)), remainingHumanDecisions: remaining,
    dryRun: { mutation: false, executionAuthorityEffect: "none", activationEffect: "none", producedNow: ["read-only explanation", "dependency projection", "answer diagnostic"], producedAfterAllExplicitConfirmations: ["CF-027 package draft", "CF-026 preview eligibility"], remainsBlocked: ["CF-026 exact confirmation", "binding qualification", "acceptance execution", "runtime authority", "activation"] },
  };
}

const placeholders = /^(?:tbd|todo|unknown|example|test|any|whatever|n\/a|none yet|placeholder|foo|bar)$/i;

export function assessOnboardingDecisionAnswers(snapshot: CleanPackageAuthoringSnapshot, answers: Array<{ questionId: string; value: unknown }>): CoachAnswerAssessment {
  const projection = projectOnboardingDecisionCoach(snapshot);
  const byId = new Map(snapshot.questions.map((item) => [item.questionId, item]));
  const answered = new Map(snapshot.questions.filter((item) => item.answerStatus === "customer-confirmed").map((item) => [item.questionId, item.confirmedValue]));
  const contradictions: string[] = [], unsafeCombinations: string[] = [], lowInformationAnswers: string[] = [], sourceInconsistencies: string[] = [], lockedQuestionIds: string[] = [];
  for (const answer of answers) {
    const question = byId.get(answer.questionId);
    if (!question) { sourceInconsistencies.push(`unknown-question:${answer.questionId}`); continue; }
    if (projection.questions.find((item) => item.questionId === answer.questionId)?.state === "locked") lockedQuestionIds.push(answer.questionId);
    try { validateCleanPackageAuthoringAnswer(question, answer.value); } catch (error) { sourceInconsistencies.push(`${answer.questionId}:${error instanceof Error ? error.message : "invalid"}`); }
    if (typeof answer.value === "string" && (placeholders.test(answer.value.trim()) || answer.value.trim().length < 2)) lowInformationAnswers.push(answer.questionId);
    if (answered.has(answer.questionId) && JSON.stringify(answered.get(answer.questionId)) !== JSON.stringify(answer.value)) contradictions.push(`confirmed-value-conflict:${answer.questionId}`);
    answered.set(answer.questionId, answer.value);
  }
  if (answered.get("stable-input-key") && answered.get("stable-input-key") === answered.get("conflict-input-key")) contradictions.push("stable-and-conflict-identifiers-equal");
  if (answered.get("action-driver-id") && answered.get("action-driver-id") === answered.get("observer-driver-id")) unsafeCombinations.push("action-observer-driver-conflation");
  if (answered.get("action-source-id") && answered.get("action-source-id") === answered.get("observer-source-id")) unsafeCombinations.push("action-observer-source-conflation");
  if (answered.get("independent-observation") === true && (unsafeCombinations.length > 0)) contradictions.push("independence-claimed-despite-conflation");
  if (answered.get("blind-retry") === true && answered.get("reconcile-before-retry") !== true) unsafeCombinations.push("blind-retry-without-reconciliation");
  if (answered.get("observer-query-input-key") && answered.get("stable-input-key") && answered.get("observer-query-input-key") !== answered.get("stable-input-key")) contradictions.push("observer-query-not-bound-to-stable-key");
  if (answered.get("duplicate-key") && answered.get("stable-input-key") && answered.get("duplicate-key") !== answered.get("stable-input-key")) contradictions.push("duplicate-check-not-bound-to-stable-key");
  const unique = (items: string[]) => [...new Set(items)].sort();
  const rejected = [...contradictions, ...unsafeCombinations, ...lowInformationAnswers, ...sourceInconsistencies, ...lockedQuestionIds].length > 0;
  return { acceptedForSubmission: !rejected, contradictions: unique(contradictions), unsafeCombinations: unique(unsafeCombinations), lowInformationAnswers: unique(lowInformationAnswers), sourceInconsistencies: unique(sourceInconsistencies), lockedQuestionIds: unique(lockedQuestionIds), projectedRemainingHumanDecisions: Math.max(0, projection.remainingHumanDecisions - new Set(answers.map((item) => item.questionId)).size), downstreamEffects: answers.map((item) => `Would explicitly confirm ${byId.get(item.questionId)?.factKey ?? item.questionId} in a new CF-027 revision.`), mutation: false, executionAuthorityEffect: "none", activationEffect: "none" };
}

export interface PortableCoachSession {
  schemaVersion: "1.0";
  tenantId: string;
  authoringSessionId: string;
  sourceInputDigest: string;
  snapshotDigest: string;
  issuedAt: string;
  expiresAt: string;
  redactedProjection: DecisionCoachProjection;
  payloadDigest: string;
  signature: string;
}

export function exportPortableCoachSession(snapshot: CleanPackageAuthoringSnapshot, input: { tenantId: string; issuedAt: string; expiresAt: string; signingKey: string }): PortableCoachSession {
  const lifetime = Date.parse(input.expiresAt) - Date.parse(input.issuedAt);
  if (snapshot.tenantId !== input.tenantId || !Number.isFinite(lifetime) || lifetime <= 0 || lifetime > 7 * 24 * 60 * 60 * 1_000 || input.signingKey.length < 16) throw new Error("Portable coach export requires matching tenant, a maximum seven-day expiry, and customer-local signing key.");
  const core = { schemaVersion: "1.0" as const, tenantId: input.tenantId, authoringSessionId: snapshot.authoringSessionId, sourceInputDigest: snapshot.sourceInputDigest, snapshotDigest: snapshot.snapshotDigest, issuedAt: input.issuedAt, expiresAt: input.expiresAt, redactedProjection: projectOnboardingDecisionCoach(snapshot) };
  const payloadDigest = cleanPackageAuthoringDigest(core);
  const signature = createHmac("sha256", input.signingKey).update(payloadDigest).digest("hex");
  return { ...core, payloadDigest, signature };
}

export function importPortableCoachSession(bundle: PortableCoachSession, expected: { tenantId: string; authoringSessionId: string; sourceInputDigest: string; snapshotDigest: string; signingKey: string; now: string }): DecisionCoachProjection {
  const { payloadDigest, signature, ...core } = bundle;
  if (bundle.tenantId !== expected.tenantId || bundle.authoringSessionId !== expected.authoringSessionId || bundle.sourceInputDigest !== expected.sourceInputDigest || bundle.snapshotDigest !== expected.snapshotDigest) throw new Error("Portable coach session is bound to different tenant, session, source, or revision.");
  if (Date.parse(expected.now) < Date.parse(bundle.issuedAt)) throw new Error("Portable coach session is not yet valid.");
  if (Date.parse(expected.now) > Date.parse(bundle.expiresAt)) throw new Error("Portable coach session has expired.");
  if (cleanPackageAuthoringDigest(core) !== payloadDigest) throw new Error("Portable coach payload digest is invalid.");
  const actual = createHmac("sha256", expected.signingKey).update(payloadDigest).digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== actual.length || !timingSafeEqual(supplied, actual)) throw new Error("Portable coach signature is invalid.");
  return structuredClone(bundle.redactedProjection);
}
