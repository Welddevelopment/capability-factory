import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "../config.js";
import type { OpenAIModelGateway } from "../model-gateway.js";
import {
  browserDiscoveryPlanSchema,
  type BrowserDiscoveryPlan,
  type BrowserDiscoveryPlanner,
  type BrowserDiscoveryPlannerInput,
  type DiscoveredBrowserControl,
} from "./browser-discovery.js";

function tokens(value: string): Set<string> {
  return new Set(value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length >= 2));
}

function score(control: DiscoveredBrowserControl, description: string): number {
  const left = tokens(`${control.accessibleName} ${control.inputType ?? ""}`);
  const right = tokens(description);
  let value = 0;
  for (const word of right) if (left.has(word)) value += word.length >= 5 ? 3 : 1;
  if (control.element === "status" && /status|confirmation|result|success/.test(description.toLowerCase())) value += 8;
  if (control.element === "button" && /submit|create|save|place|send|confirm/.test(description.toLowerCase())) value += 6;
  return value;
}

function selectBest(
  controls: DiscoveredBrowserControl[],
  description: string,
  used: Set<string>,
  predicate: (control: DiscoveredBrowserControl) => boolean,
): DiscoveredBrowserControl {
  const candidates = controls
    .filter((control) => !used.has(control.controlId) && predicate(control))
    .map((control) => ({ control, score: score(control, description) }))
    .sort((left, right) => right.score - left.score || left.control.controlId.localeCompare(right.control.controlId));
  const best = candidates[0];
  if (!best || best.score <= 0) throw new Error(`No unambiguous discovered control matched: ${description}`);
  if (candidates[1] && candidates[1].score === best.score) {
    throw new Error(`Browser discovery control mapping was ambiguous: ${description}`);
  }
  used.add(best.control.controlId);
  return best.control;
}

/**
 * Deterministic development planner. It is intentionally conservative and
 * hands off on ties; model-backed planning is tested separately.
 */
export class ConservativeHeuristicBrowserDiscoveryPlanner implements BrowserDiscoveryPlanner {
  readonly plannerId = "conservative-semantic-heuristic-v1";

  async propose(input: BrowserDiscoveryPlannerInput): Promise<BrowserDiscoveryPlan> {
    const pages = input.snapshot.pages;
    const authenticationSecrets = new Set(
      input.boundary.authentication.kind === "trusted-session-form"
        ? input.boundary.authentication.secretAliases
        : [],
    );
    const workSecretAliases = input.boundary.secretAliases.filter((alias) => !authenticationSecrets.has(alias));
    const writePage = pages
      .map((page) => ({
        page,
        fills: page.controls.filter((control) => control.canFill).length,
        writes: page.controls.filter((control) => control.canClick && control.element === "button").length,
      }))
      .filter((candidate) => candidate.fills >= input.boundary.inputs.length + workSecretAliases.length && candidate.writes > 0)
      .sort((left, right) => right.fills - left.fills || left.page.finalPath.localeCompare(right.page.finalPath))[0]?.page;
    if (!writePage) throw new Error("No discovered page contains the bounded fields and write control required by the goal.");
    const used = new Set<string>();
    const steps: BrowserDiscoveryPlan["steps"] = [];
    for (const path of input.boundary.seedPaths.filter((path) => path !== writePage.finalPath)) {
      steps.push({ kind: "navigate", path });
      const page = pages.find((candidate) => candidate.finalPath === path);
      const heading = page?.controls.find((control) => control.element === "heading" && control.accessibleName);
      if (heading) steps.push({ kind: "assert-text", controlId: heading.controlId, expectedText: heading.accessibleName });
    }
    steps.push({ kind: "navigate", path: writePage.finalPath });
    const heading = writePage.controls.find((control) => control.element === "heading" && control.accessibleName);
    if (heading) steps.push({ kind: "assert-text", controlId: heading.controlId, expectedText: heading.accessibleName });
    for (const secretAlias of workSecretAliases) {
      const control = selectBest(
        writePage.controls,
        `${secretAlias.replaceAll(/[_-]+/g, " ")} password key token credential`,
        used,
        (candidate) => candidate.canFill && candidate.inputType === "password",
      );
      steps.push({ kind: "fill-secret", controlId: control.controlId, secretAlias });
    }
    for (const field of input.boundary.inputs) {
      const control = selectBest(
        writePage.controls,
        `${field.key.replaceAll(/[_-]+/g, " ")} ${field.description}`,
        used,
        (candidate) => candidate.canFill && candidate.inputType !== "password",
      );
      steps.push({ kind: "fill", controlId: control.controlId, inputKey: field.key });
    }
    const write = selectBest(
      writePage.controls,
      "submit create save place send confirm approved write request order",
      used,
      (candidate) => candidate.canClick && candidate.element === "button",
    );
    steps.push({
      kind: "click",
      controlId: write.controlId,
      effect: "write",
      approvalKey: input.boundary.writeApprovalKey,
      sessionSecretAliases: [],
    });
    const completion = input.boundary.completion.kind === "input-contains"
      ? writePage.controls.find((candidate) =>
          candidate.locator.kind === "role" && candidate.locator.role === "main" && !used.has(candidate.controlId),
        ) ?? selectBest(
          writePage.controls,
          input.boundary.completion.description,
          used,
          (candidate) => candidate.canRead && !candidate.canFill && !candidate.canClick,
        )
      : selectBest(
          writePage.controls,
          input.boundary.completion.description,
          used,
          (candidate) => candidate.canRead && !candidate.canFill && !candidate.canClick,
        );
    steps.push(input.boundary.completion.kind === "exact-text"
      ? {
          kind: "assert-text",
          controlId: completion.controlId,
          expectedText: input.boundary.completion.expectedText,
        }
      : {
          kind: "assert-input-text",
          controlId: completion.controlId,
          inputKey: input.boundary.completion.inputKey,
        });
    return browserDiscoveryPlanSchema.parse({
      schemaVersion: "1.0",
      needKey: input.boundary.needKey,
      snapshotHash: input.snapshot.snapshotHash,
      steps,
    });
  }
}

const INSTRUCTIONS = `You plan the smallest browser workflow from a trusted read-only discovery snapshot.

Rules:
- Use only supplied observed control IDs, approved paths, ordinary input keys, secret aliases and the exact write approval key.
- Never invent a selector, host, path, request, credential, approval, verifier, control ID, script or action.
- Navigate to a page before using one of its controls.
- Preserve conservative multi-page reads when they establish necessary context.
- Use fill only on canFill controls, click only on canClick controls, and observations only on canRead controls.
- Map each approved ordinary input exactly once and each required secret alias exactly once.
- Include exactly one business-write click and then only the supplied completion observation.
- Do not add a session-auth sequence; trusted code prepends the separately approved authentication bootstrap.
- Human-required authentication gates are handled before you are called.
- On repair, change only what the supplied validation error requires.
- Return only the strict structured plan.`;

export class OpenAIBrowserDiscoveryPlanner implements BrowserDiscoveryPlanner {
  readonly plannerId = `openai-${EXPERIMENT_LIMITS.model}`;

  constructor(private readonly gateway: OpenAIModelGateway) {}

  async propose(input: BrowserDiscoveryPlannerInput): Promise<BrowserDiscoveryPlan> {
    const response = await this.gateway.create({
      model: EXPERIMENT_LIMITS.model,
      reasoning: { effort: "medium" },
      instructions: INSTRUCTIONS,
      input: JSON.stringify({
        needKey: input.boundary.needKey,
        targetAlias: input.boundary.targetAlias,
        approvedPaths: input.boundary.allowedPaths,
        approvedInputs: input.boundary.inputs,
        approvedSecretAliases: input.boundary.secretAliases,
        writeApprovalKey: input.boundary.writeApprovalKey,
        completion: input.boundary.completion,
        pages: input.snapshot.pages.map((page) => ({
          requestedPath: page.requestedPath,
          finalPath: page.finalPath,
          title: page.title,
          headings: page.headings,
          controls: page.controls.map((control) => ({
            controlId: control.controlId,
            pagePath: control.pagePath,
            element: control.element,
            accessibleName: control.accessibleName,
            inputType: control.inputType,
            hrefPath: control.hrefPath,
            canRead: control.canRead,
            canFill: control.canFill,
            canClick: control.canClick,
            humanGateSignal: control.humanGateSignal,
          })),
        })),
        snapshotHash: input.snapshot.snapshotHash,
        previousValidationError: input.previousError ?? null,
        previousPlan: input.previousPlan ?? null,
      }),
      max_output_tokens: 8_000,
      store: true,
      text: { format: zodTextFormat(browserDiscoveryPlanSchema, "browser_discovery_plan") },
    });
    if (response.status !== "completed") {
      throw new Error(`Browser discovery planning was ${response.status}: ${response.incomplete_details?.reason ?? "unknown"}`);
    }
    return browserDiscoveryPlanSchema.parse(JSON.parse(response.output_text) as unknown);
  }

  spentUsd(): number {
    return this.gateway.spentUsd();
  }
}
