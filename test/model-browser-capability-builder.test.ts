import { describe, expect, it } from "vitest";
import { BROWSER_PORTAL_UI_CONTRACT } from "../src/customer-world/browser-portal.js";
import type { ExperimentalBrowserLocator } from "../src/experimental/browser-driver.js";
import {
  StructuredModelBrowserCapabilityBuilder,
  modelBrowserCapabilityOutputSchema,
  type BrowserCapabilityModelDraftGateway,
} from "../src/experimental/model-browser-capability-builder.js";
import { buildBrowserCapabilityFromUiContract } from "../src/experimental/browser-ui-contract.js";

function modelLocator(locator: ExperimentalBrowserLocator) {
  if (locator.kind === "role") {
    return {
      kind: locator.kind,
      value: null,
      role: locator.role,
      name: locator.name ?? null,
      exact: locator.exact ?? false,
    };
  }
  return {
    kind: locator.kind,
    value: locator.value,
    role: null,
    name: null,
    exact: "exact" in locator ? locator.exact : false,
  };
}

const unused = {
  path: null,
  locator: null,
  expectedText: null,
  inputKey: null,
  outputKey: null,
  secretAlias: null,
  effect: null,
  approvalKey: null,
  sessionSecretAliases: [] as string[],
};

function validOutput() {
  const manifest = buildBrowserCapabilityFromUiContract(BROWSER_PORTAL_UI_CONTRACT);
  return modelBrowserCapabilityOutputSchema.parse({
    schemaVersion: "0.4",
    capabilityMode: "experimental-browser-actions",
    id: BROWSER_PORTAL_UI_CONTRACT.capabilityId,
    needKey: BROWSER_PORTAL_UI_CONTRACT.needKey,
    targetAlias: BROWSER_PORTAL_UI_CONTRACT.targetAlias,
    outcomeVerifierKey: BROWSER_PORTAL_UI_CONTRACT.outcomeVerifierKey,
    uiContractHash: BROWSER_PORTAL_UI_CONTRACT.contractHash,
    steps: manifest.steps.map((step) => {
      if (step.kind === "navigate") return { ...unused, kind: step.kind, path: step.path };
      const base = { ...unused, kind: step.kind, locator: modelLocator(step.locator) };
      if (step.kind === "assert-text") return { ...base, expectedText: step.expectedText };
      if (step.kind === "assert-input-text" || step.kind === "fill") return { ...base, inputKey: step.inputKey };
      if (step.kind === "read-text") return { ...base, outputKey: step.outputKey };
      if (step.kind === "fill-secret") return { ...base, secretAlias: step.secretAlias };
      return {
        ...base,
        effect: step.effect,
        approvalKey: step.approvalKey ?? null,
        sessionSecretAliases: step.sessionSecretAliases ?? [],
      };
    }),
  });
}

class RepairingGateway implements BrowserCapabilityModelDraftGateway {
  readonly modelLabel = "fake-model";
  calls = 0;

  async draft() {
    this.calls += 1;
    const output = validOutput();
    return this.calls === 1
      ? { ...output, targetAlias: "invented-target" }
      : output;
  }
}

describe("model-backed experimental browser construction", () => {
  it("repairs one invalid draft and accepts only a candidate bound to the hashed trusted UI contract", async () => {
    const gateway = new RepairingGateway();
    const builder = new StructuredModelBrowserCapabilityBuilder(
      gateway,
      [BROWSER_PORTAL_UI_CONTRACT],
      2,
    );

    const manifest = await builder.build(
      BROWSER_PORTAL_UI_CONTRACT.needKey,
      BROWSER_PORTAL_UI_CONTRACT.contractHash,
    );

    expect(gateway.calls).toBe(2);
    expect(manifest).toMatchObject({
      targetAlias: BROWSER_PORTAL_UI_CONTRACT.targetAlias,
      uiContractHash: BROWSER_PORTAL_UI_CONTRACT.contractHash,
      steps: expect.arrayContaining([
        expect.objectContaining({ kind: "click", effect: "write" }),
      ]),
    });
  });

  it("returns no capability when the diagnosed need and trusted UI hash do not match", async () => {
    const gateway = new RepairingGateway();
    const builder = new StructuredModelBrowserCapabilityBuilder(gateway, [BROWSER_PORTAL_UI_CONTRACT]);
    await expect(builder.build("unrelated-need", BROWSER_PORTAL_UI_CONTRACT.contractHash)).resolves.toBeNull();
    expect(gateway.calls).toBe(0);
  });
});
