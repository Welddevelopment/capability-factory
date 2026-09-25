import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";

// Demo bank: a deliberately basic launcher for demos Joel has banked.
// Localhost only. The paid button never fires without an explicit confirm
// in the request body — clicking it is Joel's spend decision, the same
// pattern as the pilot playground's submit button.

const HOST = "127.0.0.1";
const PORT = Number(process.env.CF_DEMO_BANK_PORT ?? 4340);
const REPO = path.resolve(import.meta.dirname, "..", "..");
const NODE_BIN = `${process.env.HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin`;
const PNPM_BIN = `${process.env.HOME}/Library/pnpm`;
const DOCKER_SOCK = `unix://${process.env.HOME}/.colima/capability-factory/docker.sock`;
const LOG_DIR = path.join(REPO, "artifacts", "demo-bank-logs");
fs.mkdirSync(LOG_DIR, { recursive: true });

interface BankedDemo {
  id: string;
  title: string;
  what: string;
  paidCostHint: string;
  preflightEnv: Record<string, string>;
  runEnv: Record<string, string>;
  script: string;
  artifactGlobDir: string;
  /** True when the demo has no paid mode at all: the free run IS the demo, and the paid endpoint refuses. */
  freeOnly?: boolean;
  /** When takes share a parent dir with other campaigns, only dirs starting with this prefix count. */
  takePrefix?: string;
}

// Joel's hard call 2026-08-24: show exactly these five, in this order.
// Everything else stays built and runnable but HIDDEN, not deleted —
// add ?all=1 to the page or API to see the full board.
const SHOWCASE = [
  "six-refusals",
  "reliability-v3",
  "browser-discovery",
  "browser-contract",
  "http-api-original",
];

const DEMOS: BankedDemo[] = [
  {
    id: "http-api-original",
    title: "The original ERPNext demo — build the connector once, reuse it (3 frozen trials)",
    what: "The simple, original story: the model drafts the HTTP connector for a real ERPNext procurement workflow (Material Request → Purchase Order → write back the reference). Trusted code validates it, rehearses it, executes it, and verifies directly in the ERP database. Three frozen trials, each a build plus a fresh-process reuse — the July run passed 3/3 as a strong confirmation. Needs the ERPNext container up.",
    paidCostHint: "~$0.62 per take (July 3/3 pass: $0.620939, 6 calls; ceiling $8 in code)",
    preflightEnv: { CF_CONFIRMATION_ACK: "procurement-model-confirmation-v2", CF_CONFIRMATION_DRY_RUN: "1" },
    runEnv: { CF_CONFIRMATION_ACK: "procurement-model-confirmation-v2" },
    script: "product:procurement:confirm",
    artifactGlobDir: "artifacts/product-live",
    takePrefix: "procurement-model-confirmation",
  },
  {
    id: "reliability-v3",
    title: "Autonomous reliability campaign (R1–R8)",
    what: "Full loop live on real ERPNext: model diagnoses the missing capability, builds, verifies pre-use, executes, DB-checked, resumes, retains; fresh-process reuse; then five adversarial cases — bounded repair, lost-response reconciliation, missing credential, missing permission, unsafe-proposal refusal.",
    paidCostHint: "~$0.50 per take (last: $0.494725, 13 calls; ceiling $7)",
    preflightEnv: { CF_RELIABILITY_CAMPAIGN_ACK: "autonomous-reliability-v3", CF_RELIABILITY_CAMPAIGN_DRY_RUN: "1" },
    runEnv: { CF_RELIABILITY_CAMPAIGN_ACK: "autonomous-reliability-v3", CF_RELIABILITY_CAMPAIGN_RUN: "1" },
    script: "product:reliability:dry-run",
    artifactGlobDir: "artifacts/reliability-campaign",
  },
  {
    id: "browser-discovery",
    title: "Browser discovery (real Chromium, no pre-written contract)",
    what: "Trusted code observes the live Gitea web UI read-only and produces a sanitized control snapshot; the model plans a capability from opaque control IDs only (never sees credentials or raw pages); Chromium executes exactly one write; the Gitea API independently verifies it; a fresh process reuses the plan with a tripwire that fails if the planner is called again. Needs the Gitea container up (pnpm pilot:gitea:up).",
    paidCostHint: "~$0.05 per take (July pass: $0.042505, 1 call; ceiling $2)",
    preflightEnv: { CF_REAL_GITEA: "1", CF_GITEA_BROWSER_DISCOVERY_MODEL_ACK: "gitea-browser-discovery-model-confirmation-v1", CF_GITEA_BROWSER_DISCOVERY_MODEL_DRY_RUN: "1" },
    runEnv: { CF_REAL_GITEA: "1", CF_GITEA_BROWSER_DISCOVERY_MODEL_ACK: "gitea-browser-discovery-model-confirmation-v1" },
    script: "product:browser:discovery:model:gitea",
    artifactGlobDir: "artifacts/gitea-browser-discovery-model-confirmation",
  },
  {
    id: "browser-contract",
    title: "Browser capability from a hashed UI contract (real Chromium)",
    what: "The model translates a pre-declared, hash-pinned UI contract into a constrained browser capability; trusted code probes it (can authenticate but cannot perform the business write), then Chromium creates exactly one Gitea issue, verified via the API; fresh-process reuse with a builder tripwire. Needs the Gitea container up.",
    paidCostHint: "~$0.05 per take (July pass: $0.043135, 1 call; ceiling $2)",
    preflightEnv: { CF_REAL_GITEA: "1", CF_GITEA_BROWSER_MODEL_CONFIRM_ACK: "gitea-browser-model-confirmation-v1", CF_GITEA_BROWSER_MODEL_CONFIRM_DRY_RUN: "1" },
    runEnv: { CF_REAL_GITEA: "1", CF_GITEA_BROWSER_MODEL_CONFIRM_ACK: "gitea-browser-model-confirmation-v1" },
    script: "product:browser:model:gitea",
    artifactGlobDir: "artifacts/gitea-browser-model-confirmation",
  },
  {
    id: "database-model",
    title: "Reviewed database contract drafted by the model (sqlite)",
    what: "The model drafts only the declarative single-statement transaction shape (strict structured output); trusted code injects tenant, allowlist, connection, limits and approvalKey, REVIEWS the draft against frozen intent (approval bound to the contract digest — the model never holds approvalKey), probes on a disposable sqlite, executes exactly one row, and an independent read-only observer verifies against trusted expected values. Fresh-process reuse must make zero model calls; an unapproved write must be refused before any write. No container needed.",
    paidCostHint: "typical ~$0.05–$0.15 per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_CONFIRMATION_ACK: "database-model-confirmation-v1", CF_CONFIRMATION_DRY_RUN: "1" },
    runEnv: { CF_CONFIRMATION_ACK: "database-model-confirmation-v1" },
    script: "product:database:model:confirm",
    artifactGlobDir: "artifacts/product-live/database-model-confirmation/takes",
  },
  {
    id: "files-edi-model",
    title: "Partner EDI contract drafted by the model (EDIFACT over an authenticated gateway)",
    what: "The model drafts ONLY the declarative partner contract facts (sender/receiver IDs, item-code allowlist, line and size limits) from a fictional EDI onboarding pack, as strict structured output. Trusted code confirms each fact against the reviewer's ground truth (a wrong extraction leaves a blocker and bind refuses), probes disposably, then imports one EDIFACT ORDERS D96A order through a live loopback gateway — bearer auth via scoped credential alias, body SHA-256 integrity, If-None-Match exclusive create, bounded parsing, approval gate and direct-database independent verification are all untouched trusted repo code. Fresh-process reuse must make zero model calls; a replayed delivery must reconcile with zero writes. No container needed. The paid draft loop has never run yet.",
    paidCostHint: "~$0.12 expected per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_CONFIRMATION_ACK: "files-edi-model-confirmation-v1", CF_CONFIRMATION_DRY_RUN: "1" },
    runEnv: { CF_CONFIRMATION_ACK: "files-edi-model-confirmation-v1" },
    script: "product:files-edi:model:confirm",
    artifactGlobDir: "artifacts/files-edi-model-confirmation/takes",
  },
  {
    id: "signed-message-model",
    title: "Signed supplier messages: model-drafted mapping, trusted replay refusal",
    what: "The model drafts ONLY the message-to-action mapping contract (which sender, recipient, subject prefix, item codes and bounds turn an accepted email into a draft order), as strict structured output checked against the trusted contract document's hash. Signature verification (HMAC-SHA256, timing-safe), replay refusal, timestamp windows, ingress trust and secrets are all untouched trusted repo code — the model never sees a business message, secret, signature, or receipt. Highlight: the exact accepted delivery is resent byte-for-byte, valid signature and all, and the ingress answers 409 replay:true; then the same duplicate is freshly re-signed with a new timestamp and it is 409 again — refusal comes from durable delivery identity, not the clock. Fresh-process reuse must make zero model calls. No container needed. The paid draft loop has never run yet.",
    paidCostHint: "~$0.05–$0.20 expected per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_CONFIRMATION_ACK: "signed-message-model-confirmation-v1", CF_CONFIRMATION_DRY_RUN: "1" },
    runEnv: { CF_CONFIRMATION_ACK: "signed-message-model-confirmation-v1" },
    script: "product:signed-message:model:confirm",
    artifactGlobDir: "artifacts/signed-message-model-confirmation/takes",
  },
  {
    id: "document-model",
    title: "Pinned PDF template manifest drafted by the model (documents family)",
    what: "The model drafts ONLY the declarative pinned-template capability manifest (title, version, item-code allowlist, line/quantity/byte bounds) from prose documentation of the fictional East Industrial purchase-order layout, as strict structured output. It writes no code, sees no PDF bytes, and touches no files. Trusted code rebuilds the same manifest deterministically from the hashed contract and requires field-by-field equality (a wrong bound fails with a named field and feeds one bounded repair), probes the capability against a disposable in-memory PDF with zero business writes, executes once under pin + approval + reconciliation, and verifies the draft against independent customer-side ground truth. PDF parsing, pinning, the probe and independent verification are all untouched trusted repo code — a deterministic builder for this manifest already exists, so the claim is seam-occupation, not new ability. Fresh-SDK reuse must make zero model calls; a missing-approval request must be refused with zero writes. No container needed. The paid draft loop has never run yet.",
    paidCostHint: "~$0.03-$0.08 expected per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_DOCUMENT_MODEL_CONFIRM_ACK: "pinned-document-model-confirmation-v1", CF_DOCUMENT_MODEL_CONFIRM_DRY_RUN: "1" },
    runEnv: { CF_DOCUMENT_MODEL_CONFIRM_ACK: "pinned-document-model-confirmation-v1" },
    script: "product:document:model:confirm",
    artifactGlobDir: "artifacts/document-model-confirmation/takes",
  },
  {
    id: "wasm-gauntlet",
    title: "WASM gate gauntlet (deterministic, $0, no model)",
    what: "Four hand-assembled WebAssembly artifacts through the existing trusted-tool gate, untouched: a good pinned adder completes a real computation and is retained then reused; an import-carrying module is REFUSED at admission (artifact.import-free) before instantiation; an infinite-loop module is KILLED by the worker timeout while the host survives; a flipped-opcode wrong-math module passes every structural check and is caught behaviourally by the deterministic probe — and by the independent verifier with quarantine when the probe is deliberately mis-pinned. Finale re-runs the gauntlet through the shared mode router. Zero model calls by design: the sandbox leaves a model nothing to author, select, or decide — the demo IS the absence of model authorship. No key, no budget, no container.",
    paidCostHint: "none — this demo has no paid mode ($0, deterministic, zero model calls)",
    preflightEnv: {},
    runEnv: {},
    script: "demo:wasm:gauntlet",
    artifactGlobDir: "artifacts/wasm-gauntlet/takes",
    freeOnly: true,
  },
  {
    id: "six-refusals",
    title: "Six refusals gauntlet (deterministic, $0, one run, six families)",
    what: "One run, six capability families, every leg adversarial — the refusal surface live: tampered PDF, replayed webhook x2, unapproved DB write, three malicious WASM modules, a real UI button outside the declared surface, a restricted ERP credential. Each refusal is verified for the documented reason with zero side effects through that family's independent channel. Needs the ERPNext container up and the Dealer Desk app built (with the Accessibility permission); fails closed with a clear message otherwise. Zero model calls by design.",
    paidCostHint: "none — this demo has no paid mode ($0, deterministic, zero model calls)",
    preflightEnv: {},
    runEnv: {},
    script: "demo:six-refusals",
    artifactGlobDir: "artifacts/six-refusals/takes",
    freeOnly: true,
  },
  {
    id: "delegation-model",
    title: "Signed delegation to an external service: model-drafted contract, tamper-evidence quarantine",
    what: "The model drafts ONLY the delegation contract proposal (which advertised task is delegated, the minimal task allowlist, timeout bound, input-field mapping, and a plain-language statement of what is delegated and what evidence is expected), as strict structured output from the counterparty's advertised description. Trusted code pins the counterparty's ed25519 public key (enrolled out of band — the model never sees key material), cross-checks every drafted identity/task/verifier/approval against the enrollment, and computes the contract hash itself. Signing stays in the counterparty (a real loopback HTTP courier-booking service with its own sqlite and keypair); receipt signature verification, exact approval, reconcile-before-execute, independent database observation, retention and quarantine are all untouched trusted SDK code. Highlight: after a successful booking, the counterparty's persisted evidence is tampered — the signed receipt still verifies, but the independent observer rejects it, the route is QUARANTINED, and a follow-up request refuses to reuse it. Durable reuse from a reopened registry must make zero model calls. No container needed. The paid draft loop has never run yet.",
    paidCostHint: "~$0.03-$0.08 expected per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_DELEGATION_DEMO_ACK: "signed-delegation-demo-v1", CF_DELEGATION_DEMO_DRY_RUN: "1" },
    runEnv: { CF_DELEGATION_DEMO_ACK: "signed-delegation-demo-v1" },
    script: "product:delegation:model:confirm",
    artifactGlobDir: "artifacts/delegation-model-confirmation/takes",
  },
  {
    id: "paper-to-ledger",
    title: "Paper to ledger: one goal crossing three families (mixed-family V1)",
    what: "One order travels the whole way: a signed webhook order notice arrives (HMAC verified, replay refused), the fictional paper purchase-order PDF it references is parsed under a pinned template, and each parsed line is written as exactly one reviewed database draft row. The model drafts all three family contracts — the message-to-action mapping, the pinned-template manifest, and the single-statement transaction shape — as strict structured output through the per-family gateways; data between legs flows only through trusted code (the verified notice PO selects the pinned PDF via a trusted pin table, and the independently verified PDF parse supplies the database leg's trusted expected values — the model never sees a business message and never carries data between legs). Signature/replay checks, PDF pinning, the review gate binding approval to the contract digest, probes, execution and independent per-leg verification are all untouched trusted repo code. Refusals on stage: a byte-identical webhook replay is 409, a tampered PDF is refused with zero writes, an unapproved database write is refused before any write. Preflight runs the complete pipeline with deterministic reference contracts ($0). At most 4 model calls per paid take. No container needed. The paid draft loop has never run yet.",
    paidCostHint: "~$0.10-0.30 per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_PAPER_TO_LEDGER_ACK: "paper-to-ledger-v1", CF_PAPER_TO_LEDGER_DRY_RUN: "1" },
    runEnv: { CF_PAPER_TO_LEDGER_ACK: "paper-to-ledger-v1" },
    script: "demo:paper-to-ledger:model",
    artifactGlobDir: "artifacts/paper-to-ledger/takes",
  },
  {
    id: "ledger-to-world",
    title: "Ledger to the world: five families chained, incl. real ERP and a native macOS app (mixed-family V2)",
    what: "HONEST MODE LABEL: this is a pipeline of independently verified legs chained by a trusted script — NOT a composed goal inside the sealed executor, and legs 4-5 are always deterministic. The restock story runs the whole way out into the world: V1's three legs run first, unchanged (signed webhook order notice accepted and replay refused; the pinned paper PDF parsed and a tampered copy refused; each verified line written as one reviewed ledger row with an unapproved write refused) — then the independently AUDITED ledger state drives two further legs through trusted code only. Leg 4: one real ERPNext procurement write through the constrained-HTTP reference capability (the seeded approved Material Request becomes exactly one Purchase Order), verified by a direct in-container database check — the verifier counts the PO create plus its reference recorded on the source request, and zero incorrect side effects. Leg 5: the same restock entered into the LIVE Dealer Desk macOS app through the real accessibility driver, against a declared surface WITHOUT the wipe button and a one-write budget, verified through the app's independent read-only SQLite channel — and the real wipe button is pressed as a tripwire and refused. The model's role is identical to V1: three contract drafts in the paid path, zero in dry-run; no model call ever occurs in legs 4-5. Needs the ERPNext container up and the Dealer Desk app built (with the Accessibility permission); fails closed with clear messages otherwise. The paid draft loop has never run yet.",
    paidCostHint: "~$0.10-0.30 per take (estimate; ceiling $2); legs 4-5 always deterministic",
    preflightEnv: { CF_LEDGER_TO_WORLD_ACK: "ledger-to-world-v1", CF_LEDGER_TO_WORLD_DRY_RUN: "1" },
    runEnv: { CF_LEDGER_TO_WORLD_ACK: "ledger-to-world-v1" },
    script: "demo:ledger-to-world:model",
    artifactGlobDir: "artifacts/ledger-to-world/takes",
  },
  {
    id: "one-goal-many-hands",
    title: "One goal, many hands: the model plans AND drafts across three families (mixed-family V4)",
    what: "the model plans the multi-family work AND drafts every capability contract — the two cognitive jobs in one run. One ordinary broad goal in prose is decomposed by the model into dependency-ordered work items against a trusted three-family scope (signed-message accept → document capture → database record, with the document→database dependency edge required); the proposal is validated by the untouched GoalPlanCompiler's full trusted checks (one repair attempt allowed), then per work item the model drafts that family's contract exactly as V1. Trusted machinery executes and independently verifies each leg; cross-leg data flows only through trusted code. Then a SECOND order's goal is handled by fresh coordinator/registry instances reopened from disk: the retained plan is re-validated from scratch by the same compiler and every leg must reuse the retained contracts with ZERO new model calls — tripwire builders throw if consulted. Refusals on stage: a byte-identical webhook replay is 409, a tampered PDF is refused with zero writes, an unapproved database write is refused before any write. HONEST MODE LABEL: validation, execution, verification and authority are all deterministic trusted code; the plan drives leg dispatch through a small trusted map in the runner; a demo route, unsealed — not a claim of generality. Preflight runs the whole two-goal structure with a deterministic reference planner through the SAME plan validation plus reference contracts ($0). At most 7 model calls per paid take (1 plan + 1 plan repair + 3 drafts + 2 shared retries). No container needed. The paid loop has never run yet.",
    paidCostHint: "~$0.30-0.60 per take (estimate, unmeasured; ceiling $2)",
    preflightEnv: { CF_ONE_GOAL_ACK: "one-goal-many-hands-v1", CF_ONE_GOAL_DRY_RUN: "1" },
    runEnv: { CF_ONE_GOAL_ACK: "one-goal-many-hands-v1" },
    script: "demo:one-goal:model",
    artifactGlobDir: "artifacts/one-goal-many-hands/takes",
  },
];

interface RunState {
  id: string;
  demoId: string;
  mode: "preflight" | "live";
  startedAt: string;
  logFile: string;
  child: ChildProcess | null;
  exitCode: number | null;
}
const runs = new Map<string, RunState>();
let liveRunActive = false;

function startRun(demo: BankedDemo, mode: "preflight" | "live"): RunState {
  const id = `${demo.id}-${mode}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const logFile = path.join(LOG_DIR, `${id}.log`);
  const out = fs.openSync(logFile, "a");
  const child = spawn("pnpm", [demo.script], {
    cwd: REPO,
    env: {
      ...process.env,
      PATH: `${PNPM_BIN}:${NODE_BIN}:${process.env.PATH ?? ""}`,
      DOCKER_HOST: process.env.DOCKER_HOST ?? DOCKER_SOCK,
      ...(mode === "preflight" ? demo.preflightEnv : demo.runEnv),
    },
    stdio: ["ignore", out, out],
    detached: false,
  });
  const state: RunState = { id, demoId: demo.id, mode, startedAt: new Date().toISOString(), logFile, child, exitCode: null };
  child.on("exit", (code) => {
    state.exitCode = code ?? -1;
    state.child = null;
    if (mode === "live") liveRunActive = false;
    fs.closeSync(out);
  });
  runs.set(id, state);
  return state;
}

// Plain-English titles for the reliability campaign's case ids, so the
// scoreboard reads as a story instead of R-numbers.
const RELIABILITY_CASE_TITLES: Record<string, string> = {
  R1: "Built its own ERP connector from an ordinary instruction",
  R2: "A fresh session reused it — rebuild path booby-trapped",
  R3: "A different job: drafted wrong, refused, repaired, passed",
  R4: "Sabotaged connector caught before one request left the machine",
  R5: "Lost reply reconciled — found the orphan, no duplicate",
  R6: "No credential: AI said go, the referee overruled it",
  R7: "No permission: stopped before any write",
  R8: "Dangerous proposal (delete an order): rejected, $0 spent",
};

interface ScoreCase { title: string; passed: boolean; detail: string }

/** Normalize a take directory into plain-English pass/fail rows, if its artifacts allow it. */
function scoreboardFor(takeDir: string): ScoreCase[] | null {
  try {
    // Shape 1: campaign dirs with case-* subdirectories (reliability).
    const caseDirs = fs.readdirSync(takeDir).filter((n) => n.startsWith("case-")).sort();
    if (caseDirs.length > 0) {
      return caseDirs.map((name) => {
        const r = JSON.parse(fs.readFileSync(path.join(takeDir, name, "result.json"), "utf8"));
        const id = String(r.id ?? name.replace("case-", ""));
        return {
          title: RELIABILITY_CASE_TITLES[id] ?? id,
          passed: r.passed === true,
          detail: `$${Number(r.spentUsd ?? 0).toFixed(4)} · ${r.modelCalls ?? 0} AI call${(r.modelCalls ?? 0) === 1 ? "" : "s"}${r.safetyFailure ? " · SAFETY FAILURE" : ""}`,
        };
      });
    }
    // Shape 2: a result.json carrying a cases[] array (six-refusals, wasm-gauntlet, mixed-family).
    const resultFile = path.join(takeDir, "result.json");
    if (fs.existsSync(resultFile)) {
      const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
      const cases: unknown = r.cases ?? r.legs ?? null;
      if (Array.isArray(cases) && cases.length > 0) {
        return cases.map((c: Record<string, unknown>) => ({
          title: String(c.title ?? c.name ?? c.family ?? c.id ?? "case"),
          passed: c.passed === true,
          detail: String(c.refusedFor ?? c.detail ?? c.summary ?? ""),
        }));
      }
    }
  } catch {
    // fall through — no scoreboard is always safe
  }
  return null;
}

function latestTakes(demo: BankedDemo, limit = 5): unknown[] {
  const dir = path.join(REPO, demo.artifactGlobDir);
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir)
    .map((name) => ({ name, full: path.join(dir, name) }))
    .filter((e) => !demo.takePrefix || e.name.startsWith(demo.takePrefix))
    .filter((e) => fs.existsSync(path.join(e.full, "result.json")))
    .sort((a, b) => fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs)
    .slice(0, limit);
  return entries.map((e, index) => {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(e.full, "result.json"), "utf8"));
      const budgetFile = path.join(e.full, "model-budget.json");
      const budget = fs.existsSync(budgetFile) ? JSON.parse(fs.readFileSync(budgetFile, "utf8")) : null;
      return {
        campaign: e.name,
        passed: r.passed ?? null,
        safetyFailure: r.safetyFailure ?? null,
        spentUsd: budget?.spentUsd ?? null,
        calls: budget?.calls ?? null,
        // Scoreboard only for the newest take — it is what renders large on the card.
        cases: index === 0 ? scoreboardFor(e.full) : null,
      };
    } catch {
      return { campaign: e.name, unreadable: true };
    }
  });
}

const app = Fastify();

app.get("/", async (_req, reply) => {
  reply.type("text/html").send(PAGE);
});

app.get<{ Querystring: { all?: string } }>("/api/demos", async (req) => {
  const showAll = req.query?.all === "1";
  const visible = showAll
    ? DEMOS
    : SHOWCASE.map((id) => DEMOS.find((d) => d.id === id)).filter((d): d is BankedDemo => d !== undefined);
  return {
    demos: visible.map((d) => ({ id: d.id, title: d.title, what: d.what, paidCostHint: d.paidCostHint, freeOnly: d.freeOnly === true, takes: latestTakes(d) })),
  };
});

app.post<{ Params: { demoId: string }; Body: { confirmPaid?: boolean } }>("/api/demos/:demoId/preflight", async (req, reply) => {
  const demo = DEMOS.find((d) => d.id === req.params.demoId);
  if (!demo) return reply.code(404).send({ error: "unknown demo" });
  const state = startRun(demo, "preflight");
  return { runId: state.id, mode: "preflight", cost: "$0" };
});

app.post<{ Params: { demoId: string }; Body: { confirmPaid?: boolean } }>("/api/demos/:demoId/run", async (req, reply) => {
  const demo = DEMOS.find((d) => d.id === req.params.demoId);
  if (!demo) return reply.code(404).send({ error: "unknown demo" });
  if (demo.freeOnly) {
    return reply.code(400).send({ error: "This demo has no paid mode. It is deterministic, $0, zero model calls — use the free run button." });
  }
  if (req.body?.confirmPaid !== true) {
    return reply.code(400).send({ error: "This is a PAID run. POST again with {\"confirmPaid\": true} — the confirm click in the page does this." });
  }
  if (liveRunActive) return reply.code(409).send({ error: "A live take is already running." });
  liveRunActive = true;
  const state = startRun(demo, "live");
  return { runId: state.id, mode: "live", cost: demo.paidCostHint };
});

app.get<{ Params: { runId: string }; Querystring: { offset?: string } }>("/api/runs/:runId/log", async (req, reply) => {
  const state = runs.get(req.params.runId);
  if (!state) return reply.code(404).send({ error: "unknown run" });
  const offset = Number(req.query.offset ?? 0);
  let chunk = "";
  if (fs.existsSync(state.logFile)) {
    const size = fs.statSync(state.logFile).size;
    if (size > offset) {
      const fd = fs.openSync(state.logFile, "r");
      const buf = Buffer.alloc(Math.min(size - offset, 65536));
      fs.readSync(fd, buf, 0, buf.length, offset);
      fs.closeSync(fd);
      chunk = buf.toString("utf8");
    }
  }
  return { runId: state.id, mode: state.mode, running: state.child !== null, exitCode: state.exitCode, offset: offset + Buffer.byteLength(chunk), chunk };
});

const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>CF Demo Bank</title>
<style>
  body{font:15px/1.5 -apple-system,sans-serif;max-width:880px;margin:2rem auto;padding:0 1rem;color:#1a1a1a}
  .demo{border:1px solid #ccc;border-radius:8px;padding:1rem 1.25rem;margin:1rem 0}
  h1{font-size:1.3rem} h2{font-size:1.05rem;margin:.2rem 0}
  button{font:inherit;padding:.45rem .9rem;border-radius:6px;border:1px solid #888;background:#f4f4f4;cursor:pointer;margin-right:.5rem}
  button.paid{background:#b33;color:#fff;border-color:#922}
  button:disabled{opacity:.5;cursor:default}
  pre{background:#111;color:#ddd;padding: .75rem;border-radius:6px;max-height:280px;overflow:auto;font-size:12px;white-space:pre-wrap}
  table{border-collapse:collapse;font-size:13px;margin:.5rem 0}
  td,th{border:1px solid #ddd;padding:.25rem .6rem;text-align:left}
  .ok{color:#0a0} .bad{color:#b33} .hint{color:#666;font-size:13px}
  .board{margin:.75rem 0;border:1px solid #e2e2e2;border-radius:8px;overflow:hidden}
  .board .row{display:flex;gap:.75rem;align-items:baseline;padding:.55rem .8rem;border-top:1px solid #eee;font-size:15px}
  .board .row:first-child{border-top:none}
  .board .mark{font-size:17px;width:1.4rem;flex:none}
  .board .t{font-weight:600}
  .board .d{color:#666;font-size:13px;margin-left:auto;text-align:right}
  .board .row.fail{background:#fff4f4}
  .verdict{font-size:16px;font-weight:700;margin:.6rem 0 .2rem}
  details{margin:.4rem 0} details summary{cursor:pointer;color:#666;font-size:13px}
  .running{color:#a60;font-weight:600}
</style>
<h1>Capability Factory — demo bank</h1>
<p class="hint">Five demos, in show order. Preflight is free and should be green before any live take. A live take is a real paid model run — the red button asks once, then spends. Keep the machine quiet during a take.</p>
<div id="demos"></div>
<script>
const SHOW_ALL = new URLSearchParams(location.search).get('all') === '1';
function board(cases){
  if(!cases || !cases.length) return '';
  const allPass = cases.every(c=>c.passed);
  return \`<div class="verdict \${allPass?'ok':'bad'}">\${allPass ? '✅ ALL CHECKS PASSED' : '❌ NOT GREEN — do not describe this take as passing'}</div>
    <div class="board">\${cases.map(c=>\`
      <div class="row \${c.passed?'':'fail'}"><span class="mark">\${c.passed?'✅':'❌'}</span><span class="t">\${c.title}</span><span class="d">\${c.detail||''}</span></div>\`).join('')}
    </div>\`;
}
async function load(){
  const r = await fetch('/api/demos' + (SHOW_ALL ? '?all=1' : '')); const data = await r.json();
  document.getElementById('demos').innerHTML = data.demos.map((d,i) => \`
    <div class="demo" id="demo-\${d.id}">
      <h2>\${i+1}. \${d.title}</h2>
      <p>\${d.what}</p>
      <p class="hint">Paid cost: \${d.paidCostHint}</p>
      \${d.freeOnly
        ? \`<button onclick="freeRun('\${d.id}', this)">Run (free — deterministic, $0, no model)</button>\`
        : \`<button onclick="preflight('\${d.id}', this)">Preflight (free)</button>
      <button class="paid" onclick="live('\${d.id}', this)">Run live take (paid)</button>\`}
      <span id="status-\${d.id}" class="running"></span>
      <div id="score-\${d.id}">\${board(d.takes[0] && d.takes[0].cases)}</div>
      <details><summary>past takes & technical log</summary>
      <table><tr><th>past take</th><th>passed</th><th>safety</th><th>spent</th><th>calls</th></tr>
      \${d.takes.map(t=>\`<tr><td>\${t.campaign}</td><td class="\${t.passed?'ok':'bad'}">\${t.passed}</td><td class="\${t.safetyFailure===false?'ok':'bad'}">\${t.safetyFailure===false?'clean':t.safetyFailure}</td><td>\$\${(t.spentUsd??0).toFixed(4)}</td><td>\${t.calls??''}</td></tr>\`).join('')}</table>
      <pre id="log-\${d.id}" hidden></pre>
      </details>
    </div>\`).join('');
}
async function preflight(id, btn){
  if(btn) btn.disabled = true;
  const r = await fetch('/api/demos/'+id+'/preflight',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  tail(id, (await r.json()).runId, ()=>{ if(btn) btn.disabled=false; load(); });
}
async function freeRun(id, btn){
  btn.disabled = true;
  const r = await fetch('/api/demos/'+id+'/preflight',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  tail(id, (await r.json()).runId, ()=>{ btn.disabled=false; load(); });
}
async function live(id, btn){
  if(!confirm('This spends real money on model calls (see cost above). Run the live take?')) return;
  btn.disabled = true;
  const r = await fetch('/api/demos/'+id+'/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({confirmPaid:true})});
  const j = await r.json();
  if(j.error){ alert(j.error); btn.disabled=false; return; }
  tail(id, j.runId, ()=>{ btn.disabled=false; load(); });
}
function tail(id, runId, done){
  const status = document.getElementById('status-'+id);
  if(status) status.textContent = ' running… results will appear here as a scoreboard when it finishes';
  const el = document.getElementById('log-'+id); el.hidden=false; el.textContent='';
  let off=0;
  const t = setInterval(async ()=>{
    const r = await fetch('/api/runs/'+runId+'/log?offset='+off); const j = await r.json();
    if(j.chunk){ el.textContent += j.chunk; el.scrollTop = el.scrollHeight; off = j.offset; }
    if(!j.running){
      clearInterval(t);
      el.textContent += '\\n== finished, exit '+j.exitCode+' ==';
      if(status) status.textContent = '';
      if(done) done();
    }
  }, 1500);
}
load();
</script>`;

app.listen({ host: HOST, port: PORT }).then(() => {
  console.log(JSON.stringify({ demoBank: `http://${HOST}:${PORT}/`, demos: DEMOS.map((d) => d.id) }));
});
