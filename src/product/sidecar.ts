import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import type { CapabilityRequest, GoalRunResult } from "./contracts.js";
import {
  BLOCKED_CONTEXT_MEDIA_TYPE,
  BLOCKED_CONTEXT_SCHEMA_VERSION,
  deserializeBlockedContext,
  serializeBlockedContext,
  type BlockedContextValidationReceipt,
} from "./blocked-context-contract.js";
import {
  broadGoalRequestSchema,
  type BroadGoalRequest,
  type BroadGoalRunResult,
} from "./broad-goal-sdk.js";
import { goalContinuationGrantSchema } from "./continuation.js";
import type { CapabilityFactorySdk, CapabilityWorkflow } from "./sdk.js";
import {
  type SidecarGoalJobEvent,
  type SidecarGoalJobReceipt,
  type SidecarGoalJobService,
} from "./sidecar-jobs.js";
import {
  type CapabilityModeJobEvent,
  type CapabilityModeJobReceipt,
  type CapabilityModeJobService,
} from "./capability-mode-jobs.js";
import {
  universalGoalSchema,
  universalGoalSubmissionSchema,
  type UniversalGoal,
  type UniversalGoalSubmission,
} from "./universal-capability-contract.js";
import type {
  PreparedCapabilityRoute,
  UniversalCapabilityCoordinator,
  UniversalResolutionReceipt,
} from "./universal-capability-coordinator.js";
import type {
  UniversalCompositionCoordinator,
  UniversalCompositionPlan,
  UniversalCompositionReceipt,
  UniversalCompositionVerifier,
} from "./universal-composition.js";
import type {
  UniversalCompositionJobEvent,
  UniversalCompositionJobReceipt,
  UniversalCompositionJobService,
} from "./universal-composition-jobs.js";

const requestSchema = z
  .object({
    context: z
      .object({
        tenantId: z.string().min(1),
        requestId: z.string().min(1),
        workflowKey: z.string().min(1),
        ordinaryGoal: z.string().min(1),
        blockedAt: z.string().min(1),
        blockedReason: z.string().min(1),
        visibility: z.enum(["exceptions-only", "summary", "full"]),
      })
      .strict(),
    need: z
      .object({
        key: z.string().min(1),
        summary: z.string().min(1),
        requiredActions: z.array(z.string()),
        targetAliases: z.array(z.string()),
        secretAliases: z.array(z.string()),
        documentationHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
    authority: z
      .object({
        allowedTargetAliases: z.array(z.string()),
        allowedSecretAliases: z.array(z.string()),
        allowedMethods: z.array(z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])),
        writeAuthority: z.enum(["denied", "preauthorized", "per-action-approval"]),
        approvedWriteActions: z.array(z.string()),
      })
      .strict(),
    runtimeProfile: z.string().min(1),
  })
  .strict();

export interface SidecarWorkflowResolver {
  resolve(workflowKey: string): CapabilityWorkflow | undefined;
}

export interface SidecarOptions {
  /** Local shared secret between the thin agent client and customer-hosted sidecar. */
  accessToken: string;
  /** Optional broad-goal route. SDK-only users do not need to expose HTTP. */
  broadGoals?: {
    completeGoal(request: BroadGoalRequest): Promise<BroadGoalRunResult>;
    continueGoal?(request: BroadGoalRequest, grant: z.infer<typeof goalContinuationGrantSchema>): Promise<BroadGoalRunResult>;
  };
  /** Durable asynchronous jobs for broad goals that may outlive one HTTP request. */
  goalJobs?: SidecarGoalJobService;
  /**
   * Explicit multi-mode boundary. Each registered driver keeps its own request
   * schema, permissions, evidence and maturity label.
   */
  capabilityModeJobs?: CapabilityModeJobService;
  /**
   * Ordinary-goal entrance over the cross-mode coordinator. Trusted local
   * preparation diagnoses the gap and constructs bounded route candidates;
   * the customer agent never supplies a capability mode.
   */
  universalCapabilities?: {
    coordinator: UniversalCapabilityCoordinator;
    prepare(submission: UniversalGoalSubmission): Promise<{
      goal: UniversalGoal;
      routes: PreparedCapabilityRoute[];
    }>;
  };
  /** Trusted multi-capability preparation and aggregate verification. */
  universalCompositions?: {
    coordinator: UniversalCompositionCoordinator;
    prepare(submission: UniversalGoalSubmission): Promise<{
      plan: UniversalCompositionPlan;
      verifier: UniversalCompositionVerifier;
    }>;
  };
  /** Durable exact-plan execution for compositions that may outlive one request. */
  universalCompositionJobs?: UniversalCompositionJobService;
}

function sameToken(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function createCapabilitySidecar(
  sdk: CapabilityFactorySdk | undefined,
  workflows: SidecarWorkflowResolver,
  options: SidecarOptions,
): FastifyInstance {
  if (options.accessToken.length < 16) throw new Error("Sidecar access token must contain at least 16 characters");
  const app = Fastify({ logger: false, bodyLimit: 256_000 });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/ready", async (_request, reply) => {
    const jobHealth = options.goalJobs?.health();
    const modeJobHealth = options.capabilityModeJobs?.health();
    const compositionJobHealth = options.universalCompositionJobs?.health();
    const ready = Boolean(sdk || options.broadGoals || options.goalJobs || options.capabilityModeJobs || options.universalCapabilities || options.universalCompositions || options.universalCompositionJobs)
      && jobHealth?.status !== "degraded"
      && modeJobHealth?.status !== "degraded"
      && compositionJobHealth?.status !== "degraded";
    if (!ready) reply.code(503);
    return {
      status: ready
        ? "ready"
        : jobHealth?.status === "degraded" || modeJobHealth?.status === "degraded" || compositionJobHealth?.status === "degraded"
          ? "degraded"
          : "not-ready",
    };
  });
  app.addHook("onReady", async () => {
    options.goalJobs?.recover();
    options.capabilityModeJobs?.recover();
    options.universalCompositionJobs?.recover();
  });
  app.addHook("onClose", async () => {
    await options.goalJobs?.close();
    await options.capabilityModeJobs?.close();
    await options.universalCompositionJobs?.close();
  });
  app.post("/v1/onboarding/blocked-context/validate", async (rawRequest, reply): Promise<BlockedContextValidationReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    let contract;
    try {
      contract = deserializeBlockedContext(serializeBlockedContext(rawRequest.body));
    } catch {
      reply.code(400);
      return { error: "Invalid or secret-bearing blocked-context contract" };
    }
    reply.code(202);
    return {
      schemaVersion: BLOCKED_CONTEXT_SCHEMA_VERSION,
      accepted: true,
      mediaType: BLOCKED_CONTEXT_MEDIA_TYPE,
      authorityEffect: "none",
      next: "adapter-discovery-review",
      contract,
    };
  });
  app.post("/v1/blocked-goals", async (rawRequest, reply): Promise<GoalRunResult | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!sdk) {
      reply.code(404);
      return { error: "Blocked-goal capability SDK is not configured" };
    }
    const parsed = requestSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid blocked-goal request" };
    }
    const request = parsed.data as CapabilityRequest;
    const workflow = workflows.resolve(request.context.workflowKey);
    if (!workflow) {
      reply.code(404);
      return { error: "Unknown workflow" };
    }
    return sdk.completeBlockedGoal(request, workflow);
  });
  app.post("/v1/goals", async (rawRequest, reply): Promise<BroadGoalRunResult | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.broadGoals) {
      reply.code(404);
      return { error: "Broad-goal coordinator is not configured" };
    }
    const parsed = broadGoalRequestSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid broad-goal request" };
    }
    return options.broadGoals.completeGoal(parsed.data);
  });
  app.post("/v1/goals/continue", async (rawRequest, reply): Promise<BroadGoalRunResult | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.broadGoals?.continueGoal) {
      reply.code(404);
      return { error: "Broad-goal continuation is not configured" };
    }
    const parsed = z.object({ request: broadGoalRequestSchema, grant: goalContinuationGrantSchema }).strict().safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid broad-goal continuation" };
    }
    try {
      return await options.broadGoals.continueGoal(parsed.data.request, parsed.data.grant);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Goal cannot be continued" };
    }
  });
  app.post("/v1/goal-jobs", async (rawRequest, reply): Promise<SidecarGoalJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.goalJobs) {
      reply.code(404);
      return { error: "Durable broad-goal jobs are not configured" };
    }
    const parsed = broadGoalRequestSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid broad-goal request" };
    }
    try {
      const submitted = options.goalJobs.submit(parsed.data);
      reply.code(submitted.job.status === "queued" || submitted.job.status === "running" ? 202 : 200);
      return submitted.job;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Goal job conflict" };
    }
  });
  app.get("/v1/goal-jobs/:jobId", async (rawRequest, reply): Promise<SidecarGoalJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.goalJobs) {
      reply.code(404);
      return { error: "Durable broad-goal jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({ tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/) }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid goal-job lookup" };
    }
    const job = options.goalJobs.get(query.data.tenantId, params.data.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Goal job not found" };
    }
    return job;
  });
  app.get("/v1/goal-jobs/:jobId/events", async (rawRequest, reply): Promise<{ events: SidecarGoalJobEvent[] } | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.goalJobs) {
      reply.code(404);
      return { error: "Durable broad-goal jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({
      tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
      after: z.coerce.number().int().nonnegative().default(0),
    }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid goal-job event lookup" };
    }
    if (!options.goalJobs.get(query.data.tenantId, params.data.jobId)) {
      reply.code(404);
      return { error: "Goal job not found" };
    }
    return { events: options.goalJobs.events(query.data.tenantId, params.data.jobId, query.data.after) };
  });
  app.post("/v1/goal-jobs/:jobId/retry", async (rawRequest, reply): Promise<SidecarGoalJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.goalJobs) {
      reply.code(404);
      return { error: "Durable broad-goal jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const body = z.object({ tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/) }).strict().safeParse(rawRequest.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "Invalid goal-job retry" };
    }
    try {
      reply.code(202);
      return options.goalJobs.retry(body.data.tenantId, params.data.jobId);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Goal job cannot be retried" };
    }
  });
  app.post("/v1/goal-jobs/:jobId/continue", async (rawRequest, reply): Promise<SidecarGoalJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.goalJobs) {
      reply.code(404);
      return { error: "Durable broad-goal jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const body = z.object({ tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/), grant: goalContinuationGrantSchema }).strict().safeParse(rawRequest.body);
    if (!params.success || !body.success) {
      reply.code(400);
      return { error: "Invalid goal-job continuation" };
    }
    try {
      reply.code(202);
      return options.goalJobs.continue(body.data.tenantId, params.data.jobId, body.data.grant);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Goal job cannot be continued" };
    }
  });
  app.get("/v1/capability-modes", async (rawRequest, reply) => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.capabilityModeJobs) {
      reply.code(404);
      return { error: "Capability-mode jobs are not configured" };
    }
    return {
      schemaVersion: "1.0",
      selection: "trusted-explicit",
      inference: false,
      modes: options.capabilityModeJobs.descriptors(),
    };
  });
  app.get("/v1/runtime-families", async (rawRequest, reply) => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCapabilities) {
      reply.code(404);
      return { error: "Universal capability coordination is not configured" };
    }
    return {
      schemaVersion: "1.0",
      selection: "trusted-automatic",
      callerSelectsMode: false,
      evidenceWarning: "A registered family is architectural scope; only enabled families may execute and each keeps its own evidence boundary.",
      families: options.universalCapabilities.coordinator.descriptors(),
    };
  });
  app.post("/v1/universal-goals", async (rawRequest, reply): Promise<UniversalResolutionReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCapabilities) {
      reply.code(404);
      return { error: "Universal capability coordination is not configured" };
    }
    const parsed = universalGoalSubmissionSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid universal-goal submission" };
    }
    try {
      const prepared = await options.universalCapabilities.prepare(parsed.data);
      const goal = universalGoalSchema.parse(prepared.goal);
      if (
        goal.tenantId !== parsed.data.tenantId
        || goal.requestId !== parsed.data.requestId
        || goal.parentGoalId !== parsed.data.parentGoalId
        || goal.ordinaryGoal !== parsed.data.ordinaryGoal
      ) {
        reply.code(409);
        return { error: "Trusted preparation changed the immutable ordinary-goal identity" };
      }
      return await options.universalCapabilities.coordinator.resolve(goal, prepared.routes);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Universal capability resolution failed" };
    }
  });
  app.post("/v1/universal-compositions", async (rawRequest, reply): Promise<UniversalCompositionReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCompositions) {
      reply.code(404);
      return { error: "Universal composition is not configured" };
    }
    const parsed = universalGoalSubmissionSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid universal-composition submission" };
    }
    try {
      const prepared = await options.universalCompositions.prepare(parsed.data);
      if (
        prepared.plan.tenantId !== parsed.data.tenantId
        || prepared.plan.requestId !== parsed.data.requestId
        || prepared.plan.parentGoalId !== parsed.data.parentGoalId
        || prepared.plan.ordinaryGoal !== parsed.data.ordinaryGoal
      ) {
        reply.code(409);
        return { error: "Trusted composition preparation changed immutable ordinary-goal identity" };
      }
      return await options.universalCompositions.coordinator.resolve(prepared.plan, prepared.verifier);
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Universal composition failed" };
    }
  });
  app.post("/v1/universal-composition-jobs", async (rawRequest, reply): Promise<UniversalCompositionJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCompositionJobs) {
      reply.code(404);
      return { error: "Durable universal-composition jobs are not configured" };
    }
    const parsed = universalGoalSubmissionSchema.safeParse(rawRequest.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: "Invalid universal-composition submission" };
    }
    try {
      const submitted = await options.universalCompositionJobs.submit(parsed.data);
      reply.code(submitted.job.status === "queued" || submitted.job.status === "running" ? 202 : 200);
      return submitted.job;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Universal-composition job conflict" };
    }
  });
  app.get("/v1/universal-composition-jobs/:jobId", async (rawRequest, reply): Promise<UniversalCompositionJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCompositionJobs) {
      reply.code(404);
      return { error: "Durable universal-composition jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({
      tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
    }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid universal-composition job lookup" };
    }
    const job = options.universalCompositionJobs.get(query.data.tenantId, params.data.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Universal-composition job not found" };
    }
    return job;
  });
  app.get("/v1/universal-composition-jobs/:jobId/events", async (rawRequest, reply): Promise<{ events: UniversalCompositionJobEvent[] } | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.universalCompositionJobs) {
      reply.code(404);
      return { error: "Durable universal-composition jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({
      tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
      after: z.coerce.number().int().nonnegative().default(0),
    }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid universal-composition event lookup" };
    }
    if (!options.universalCompositionJobs.get(query.data.tenantId, params.data.jobId)) {
      reply.code(404);
      return { error: "Universal-composition job not found" };
    }
    return {
      events: options.universalCompositionJobs.events(query.data.tenantId, params.data.jobId, query.data.after),
    };
  });
  app.post("/v1/capability-mode-jobs", async (rawRequest, reply): Promise<CapabilityModeJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.capabilityModeJobs) {
      reply.code(404);
      return { error: "Capability-mode jobs are not configured" };
    }
    try {
      const submitted = options.capabilityModeJobs.submit(rawRequest.body);
      reply.code(submitted.job.status === "queued" || submitted.job.status === "running" ? 202 : 200);
      return submitted.job;
    } catch (error) {
      reply.code(409);
      return { error: error instanceof Error ? error.message : "Capability-mode job conflict" };
    }
  });
  app.get("/v1/capability-mode-jobs/:jobId", async (rawRequest, reply): Promise<CapabilityModeJobReceipt | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.capabilityModeJobs) {
      reply.code(404);
      return { error: "Capability-mode jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({
      tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
    }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid capability-mode job lookup" };
    }
    const job = options.capabilityModeJobs.get(query.data.tenantId, params.data.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Capability-mode job not found" };
    }
    return job;
  });
  app.get("/v1/capability-mode-jobs/:jobId/events", async (rawRequest, reply): Promise<{ events: CapabilityModeJobEvent[] } | { error: string }> => {
    const accessToken = rawRequest.headers["x-capability-sidecar-token"];
    if (typeof accessToken !== "string" || !sameToken(accessToken, options.accessToken)) {
      reply.code(401);
      return { error: "Unauthorized" };
    }
    if (!options.capabilityModeJobs) {
      reply.code(404);
      return { error: "Capability-mode jobs are not configured" };
    }
    const params = z.object({ jobId: z.string().regex(/^[a-f0-9]{32}$/) }).safeParse(rawRequest.params);
    const query = z.object({
      tenantId: z.string().min(1).max(160).regex(/^[a-zA-Z0-9_-]+$/),
      after: z.coerce.number().int().nonnegative().default(0),
    }).safeParse(rawRequest.query);
    if (!params.success || !query.success) {
      reply.code(400);
      return { error: "Invalid capability-mode event lookup" };
    }
    if (!options.capabilityModeJobs.get(query.data.tenantId, params.data.jobId)) {
      reply.code(404);
      return { error: "Capability-mode job not found" };
    }
    return {
      events: options.capabilityModeJobs.events(query.data.tenantId, params.data.jobId, query.data.after),
    };
  });
  return app;
}
