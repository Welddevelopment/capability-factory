import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { makeConsoleEvent, recordingDigest } from "../shared/contracts.js";
import { LocalReferenceAuthority } from "./authority.js";
import { recordedFixture, playgroundEvents } from "./fixtures.js";
import { LIVE_ORDER_OPERATIONS_FIXTURE, runLiveBroadGoalReference } from "./live-goal-coordinator.js";
import { projectGoalPlan, projectHandoffs, projectRuns } from "./projections.js";
import { ConsoleSidecarGoalBridge, type ConsoleSidecarConfiguration } from "./sidecar-goal-coordinator.js";
import { ConsoleEventStore } from "./store.js";
import { projectPilotSetup, type ConsolePilotSetupInputs } from "./pilot-setup.js";
import { projectAssistedOnboarding, type AssistedOnboardingInputs } from "./onboarding-journey.js";
import { CustomerLocalOperationalControl, type OperationalMode } from "../../../src/product/operations.js";

const TENANT = "local-alpha";
const frontend = join(process.cwd(), "apps/console/frontend");

export interface CreateConsoleAppOptions {
  databasePath?: string;
  goalDataDirectory?: string;
  sidecar?: ConsoleSidecarConfiguration;
  operationalControl?: CustomerLocalOperationalControl;
  pilotSetup?: ConsolePilotSetupInputs;
  onboardingJourney?: AssistedOnboardingInputs;
  recordingProfile?: {
    routeBadge?: string;
    suggestedGoal?: string;
    defaultMode?: "goal-plan-complete" | "sidecar-live";
  };
  /**
   * PROP-0007 demo mode. "genuine" restricts the playground to the customer-local
   * sidecar route so the on-screen badge can never describe a run it does not match.
   * Absent means no restriction (existing behaviour).
   */
  demoMode?: "reference" | "genuine";
}

export function createConsoleApp(options: CreateConsoleAppOptions = {}) {
  const app = Fastify({ logger: false });
  const store = new ConsoleEventStore(options.databasePath);
  const temporaryGoalData = !options.goalDataDirectory && (!options.databasePath || options.databasePath === ":memory:");
  const goalDataDirectory = options.goalDataDirectory ?? (temporaryGoalData
    ? mkdtempSync(join(tmpdir(), "cf-console-goals-"))
    : join(dirname(options.databasePath!), "broad-goals"));
  const authority = new LocalReferenceAuthority();
  const ownsOperationalControl = !options.operationalControl;
  const operationalControl = options.operationalControl ?? new CustomerLocalOperationalControl(
    !options.databasePath || options.databasePath === ":memory:"
      ? ":memory:"
      : join(dirname(options.databasePath), "operations.sqlite"),
    TENANT,
    { maxWriteAttemptsPerRun: 20, maxWriteAttemptsPerHour: 200, maxModelSpendUsdPerDay: 5 },
  );
  const listeners = new Set<(sequence: number, body: string) => void>();
  const append = (event: Parameters<typeof store.append>[0]) => {
    const result = store.append(event);
    if (result.inserted) for (const listener of listeners) listener(result.sequence, JSON.stringify(event));
    return result;
  };
  const sidecarBridge = options.sidecar
    ? new ConsoleSidecarGoalBridge(options.sidecar, TENANT, append)
    : undefined;
  const fixture = recordedFixture();
  if (recordingDigest(fixture.events) !== fixture.digest) throw new Error("Recorded fixture digest mismatch");
  fixture.events.forEach(append);

  app.get("/api/health", async () => ({
    status: "ok",
    product: "Capability Factory Console",
    posture: "private-alpha",
    tenantId: TENANT,
    sidecar: options.sidecar
      ? { configured: true, fixtureLabel: options.sidecar.fixtureLabel, workflowLabel: options.sidecar.workflowLabel, suggestedGoal: options.sidecar.suggestedGoal, continuationConfigured: sidecarBridge?.continuationConfigured() === true }
      : { configured: false },
    operations: { mode: operationalControl.mode() },
    ...(options.recordingProfile ? { recordingProfile: options.recordingProfile } : {}),
    ...(options.demoMode ? { demoMode: options.demoMode } : {}),
  }));
  app.get("/api/runs", async () => projectRuns(store.list(TENANT).map((row) => row.event)).map(({ events: _events, ...run }) => run));
  app.get("/api/runs/:runId", async (request, reply) => {
    const { runId } = z.object({ runId: z.string() }).parse(request.params);
    const allEvents = store.list(TENANT).map((row) => row.event);
    const run = projectRuns(allEvents.filter((event) => event.runId === runId))[0];
    if (!run) return reply.code(404).send({ error: "Run not found" });
    const goalPlan = projectGoalPlan(allEvents, runId);
    return { ...run, ...(goalPlan ? { goalPlan } : {}) };
  });
  app.get("/api/handoffs", async () => projectHandoffs(store.list(TENANT).map((row) => row.event)).map((handoff) => ({
    ...handoff,
    continuable: Boolean(
      sidecarBridge?.continuationConfigured()
      && handoff.workItemId
      && handoff.parentGoalId
      && handoff.expectedStateVersion !== undefined
      && ["open", "acknowledged"].includes(handoff.lifecycle),
    ),
  })));
  app.get("/api/capabilities", async () => authority.listCapabilities());
  app.get("/api/capability-modes", async () => {
    if (!options.sidecar?.client.listCapabilityModes) {
      return {
        configured: false,
        selection: "trusted-explicit",
        inference: false,
        modes: [],
        boundary: "Connect the customer-local multi-mode sidecar to inspect configured drivers.",
      };
    }
    const registry = await options.sidecar.client.listCapabilityModes();
    return {
      configured: true,
      ...registry,
      boundary: "One customer-local boundary; separate drivers, permissions, verification evidence, and maturity claims.",
    };
  });
  app.get("/api/environments", async () => authority.environments);
  app.get("/api/policies", async () => authority.listPolicies());
  app.get("/api/operations", async () => ({
    mode: operationalControl.mode(),
    incidents: operationalControl.incidents(),
    audit: operationalControl.verifyAuditChain(),
    controls: {
      running: "Capability actions may execute inside policy.",
      draining: "Reads may finish; new writes are stopped.",
      halted: "All capability actions are stopped before external execution.",
    },
  }));
  app.get("/api/pilot-setup", async () => {
    const capabilities = authority.listCapabilities();
    const handoffs = projectHandoffs(store.list(TENANT).map((row) => row.event));
    return projectPilotSetup(options.pilotSetup, {
      operationalMode: operationalControl.mode(),
      auditPassed: operationalControl.verifyAuditChain().passed,
      openHandoffs: handoffs.filter((item) => ["open", "acknowledged"].includes(item.lifecycle)).length,
      activeCapabilities: capabilities.filter((item) => item.status === "active").length,
      quarantinedCapabilities: capabilities.filter((item) => item.status === "quarantined").length,
    });
  });
  app.get("/api/onboarding-journey", async () => projectAssistedOnboarding(options.onboardingJourney));

  app.post("/api/operations/mode", async (request, reply) => {
    const body = z.object({
      expectedMode: z.enum(["running", "draining", "halted"]),
      mode: z.enum(["running", "draining", "halted"]),
      reason: z.string().trim().min(8).max(300),
      confirmation: z.string(),
    }).strict().parse(request.body);
    if (operationalControl.mode() !== body.expectedMode) return reply.code(409).send({ error: "Operational mode changed. Refresh before issuing another command." });
    if (body.confirmation !== `SET ${body.mode.toUpperCase()}`) return reply.code(400).send({ error: `Type SET ${body.mode.toUpperCase()} to confirm this control change.` });
    operationalControl.setMode(body.mode as OperationalMode, body.reason);
    append(makeConsoleEvent({
      tenantId: TENANT,
      runId: `operations-${randomUUID()}`,
      requestId: `operations-${randomUUID()}`,
      type: "operations.mode.changed",
      occurredAt: new Date().toISOString(),
      payload: { previousMode: body.expectedMode, mode: body.mode, reason: body.reason },
      sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true },
    }));
    return { mode: operationalControl.mode(), audit: operationalControl.verifyAuditChain() };
  });

  app.post("/api/playground/runs", async (request, reply) => {
    const input = z.object({ goal: z.string().min(12).max(600), mode: z.enum(["complete", "permission-handoff", "goal-plan-partial", "goal-plan-complete", "sidecar-live"]).default("complete"), fixture: z.literal(LIVE_ORDER_OPERATIONS_FIXTURE).optional() }).strict().parse(request.body);
    const runId = `playground-${randomUUID()}`; const requestId = `request-${randomUUID()}`;
    if (input.mode === "sidecar-live") {
      if (!sidecarBridge || !options.sidecar) return reply.code(503).send({ error: "No customer-local sidecar is configured for this console." });
      const parentGoalId = `goal-${randomUUID()}`;
      const identity = await sidecarBridge.start({ runId, requestId, parentGoalId, ordinaryGoal: input.goal });
      return reply.code(202).send({
        runId,
        requestId,
        parentGoalId,
        jobId: identity.jobId,
        source: "customer-sidecar",
        execution: "durable-sidecar",
        fixture: options.sidecar.fixtureLabel,
      });
    }
    const goalPlan = input.mode.startsWith("goal-plan")
      ? await runLiveBroadGoalReference({
          runId,
          requestId,
          ordinaryGoal: input.goal,
          scenario: input.mode === "goal-plan-complete" ? "complete-authority" : "partial-authority",
          dataDirectory: goalDataDirectory,
        })
      : undefined;
    const events = goalPlan?.events ?? playgroundEvents(runId, requestId, input.goal, input.mode as "complete" | "permission-handoff");
    events.forEach(append);
    return reply.code(201).send({ runId, requestId, source: "agent-playground", ...(goalPlan ? { parentGoalId: goalPlan.parentGoalId, fixture: LIVE_ORDER_OPERATIONS_FIXTURE, execution: "verified-reference" } : {}) });
  });
  app.post("/api/capabilities/:id/:command", async (request) => {
    const params = z.object({ id: z.string(), command: z.enum(["quarantine", "revoke"]) }).parse(request.params);
    const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body);
    const capability = authority.capabilityCommand(params.id, params.command, body.expectedVersion);
    append(makeConsoleEvent({ tenantId: TENANT, runId: `command-${randomUUID()}`, requestId: `command-${randomUUID()}`,
      type: params.command === "revoke" ? "capability.revoked" : "capability.quarantined", occurredAt: new Date().toISOString(),
      payload: { capabilityId: capability.capabilityId, status: capability.status, authorityVersion: capability.version },
      sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true } }));
    return capability;
  });
  app.post("/api/handoffs/:id/acknowledge", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    const handoff = projectHandoffs(store.list(TENANT).map((row) => row.event)).find((item) => item.handoffId === id);
    if (!handoff) throw new Error("Handoff not found");
    append(makeConsoleEvent({ tenantId: TENANT, runId: handoff.runId, requestId: `ack-${randomUUID()}`, type: "handoff.lifecycle.changed", occurredAt: new Date().toISOString(),
      payload: { handoffId: id, lifecycle: "acknowledged" }, sensitivity: { classification: "tenant-confidential", source: "console-adapter", sanitized: true } }));
    return { handoffId: id, lifecycle: "acknowledged" };
  });
  app.post("/api/handoffs/:id/continue", async (request, reply) => {
    if (!sidecarBridge || !options.sidecar) return reply.code(503).send({ error: "No customer-local sidecar continuation authority is configured." });
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      expectedStateVersion: z.number().int().nonnegative(),
      issuedBy: z.string().trim().min(3).max(100),
      confirmation: z.literal("APPROVE EXACT BLOCKED ACTION"),
    }).strict().parse(request.body);
    const allEvents = store.list(TENANT).map((row) => row.event);
    const handoffEvent = allEvents.find((event) => event.type === "handoff.created" && event.payload.handoffId === id);
    if (!handoffEvent) return reply.code(404).send({ error: "Handoff not found." });
    const workItemId = handoffEvent.payload.workItemId;
    const parentGoalId = handoffEvent.payload.parentGoalId;
    if (typeof workItemId !== "string" || typeof parentGoalId !== "string") {
      return reply.code(409).send({ error: "This handoff does not identify one exact durable work item." });
    }
    const parentReceived = allEvents.find((event) => event.type === "goal.received"
      && event.payload.parentGoalId === parentGoalId
      && typeof event.payload.jobId === "string");
    if (!parentReceived || typeof parentReceived.payload.jobId !== "string") {
      return reply.code(409).send({ error: "This handoff is not linked to a durable sidecar job." });
    }
    const receipt = await sidecarBridge.continue({
      identity: {
        runId: parentReceived.runId,
        requestId: parentReceived.requestId,
        parentGoalId,
        jobId: parentReceived.payload.jobId,
        ordinaryGoal: typeof parentReceived.payload.goal === "string" ? parentReceived.payload.goal : "Approved customer goal",
      },
      handoffId: id,
      handoffRunId: handoffEvent.runId,
      workItemId,
      expectedStateVersion: body.expectedStateVersion,
      issuedBy: body.issuedBy,
    });
    return reply.code(202).send({ handoffId: id, jobId: receipt.jobId, status: receipt.status, continuationGrantId: receipt.continuationGrantId });
  });
  const policyInput = z.object({ name: z.string().min(3), allowedTargets: z.array(z.string()).min(1), credentialAliases: z.array(z.string()), methods: z.array(z.string()).min(1), writeAuthority: z.enum(["denied", "preauthorized", "per-action-approval"]), approvedActions: z.array(z.string()) });
  app.post("/api/policies", async (request, reply) => reply.code(201).send(authority.createPolicy(policyInput.parse(request.body))));
  for (const command of ["validate", "test", "activate"] as const) app.post(`/api/policies/:version/${command}`, async (request) => {
    const { version } = z.object({ version: z.coerce.number().int().positive() }).parse(request.params);
    const policy = command === "validate" ? authority.validatePolicy(version) : command === "test" ? authority.testPolicy(version) : authority.activatePolicy(version);
    const types = { validate: "policy.validated", test: "policy.acceptance.completed", activate: "policy.activated" } as const;
    append(makeConsoleEvent({ tenantId: TENANT, runId: `policy-${version}`, requestId: `policy-${randomUUID()}`, type: types[command], occurredAt: new Date().toISOString(), payload: { policyId: policy.policyId, version, status: policy.status, acceptancePassed: policy.acceptancePassed }, sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true } }));
    return policy;
  });
  app.post("/api/environments/:id/test", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params); const environment = authority.testEnvironment(id);
    append(makeConsoleEvent({ tenantId: TENANT, runId: `environment-${id}`, requestId: `environment-${randomUUID()}`, type: "environment.acceptance.completed", occurredAt: new Date().toISOString(), payload: { environmentId: id, passed: true }, sensitivity: { classification: "security-sensitive", source: "console-adapter", sanitized: true } }));
    return environment;
  });

  app.get("/api/events", async (request, reply) => {
    const query = z.object({ after: z.coerce.number().int().nonnegative().default(0) }).parse(request.query);
    reply.hijack(); reply.raw.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (const row of store.list(TENANT, query.after)) reply.raw.write(`id: ${row.sequence}\ndata: ${JSON.stringify(row.event)}\n\n`);
    const listener = (sequence: number, body: string) => reply.raw.write(`id: ${sequence}\ndata: ${body}\n\n`);
    listeners.add(listener); request.raw.on("close", () => listeners.delete(listener));
  });

  for (const asset of ["app.js", "styles.css"] as const) app.get(`/assets/${asset}`, async (_request, reply) => reply.type(asset.endsWith(".js") ? "text/javascript" : "text/css").send(readFileSync(join(frontend, asset))));
  app.get("/*", async (_request, reply) => reply.type("text/html").send(readFileSync(join(frontend, "index.html"))));
  app.addHook("onClose", async () => {
    await sidecarBridge?.close();
    if (ownsOperationalControl) operationalControl.close();
    store.close();
    if (temporaryGoalData) rmSync(goalDataDirectory, { recursive: true, force: true });
  });

  if (sidecarBridge && options.sidecar) {
    const existing = store.list(TENANT).map((row) => row.event);
    for (const run of projectRuns(existing)) {
      if (run.source !== "customer-sidecar" || run.status !== "running") continue;
      const received = run.events.find((event) => event.type === "goal.received");
      const jobId = received?.payload.jobId;
      const parentGoalId = received?.payload.parentGoalId;
      if (typeof jobId !== "string" || typeof parentGoalId !== "string") continue;
      sidecarBridge.resume({
        runId: run.runId,
        requestId: run.requestId,
        parentGoalId,
        jobId,
        ordinaryGoal: run.goal,
      });
    }
  }
  return { app, store, authority, operationalControl };
}
