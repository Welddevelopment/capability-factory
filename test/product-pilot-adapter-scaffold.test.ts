import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPilotAdapterScaffold,
  pilotAdapterIntakeSchema,
  type PilotAdapterIntake,
} from "../src/product/pilot-adapter-scaffold.js";
import { REQUIRED_PILOT_ADAPTER_CASES, validatePilotAdapterDescriptor } from "../src/product/pilot-adapter.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-adapter-scaffold-"));
  roots.push(root);
  const documentationRoot = path.join(root, "intake");
  fs.mkdirSync(path.join(documentationRoot, "documentation"), { recursive: true, mode: 0o700 });
  const documentation = JSON.stringify({ openapi: "3.1.0", paths: { "/orders": { get: {}, post: {} } } }, null, 2);
  fs.writeFileSync(path.join(documentationRoot, "documentation", "orders.json"), documentation, { mode: 0o600 });
  const intake: PilotAdapterIntake = {
    schemaVersion: "1.0",
    adapterId: "customer-order-pilot",
    adapterVersion: "0.1.0",
    environmentId: "customer-sandbox",
    scopeKeys: ["approved-order-scope"],
    workflowKeys: ["create-approved-order"],
    targetAliases: ["customer_erp"],
    credentialAliases: ["CUSTOMER_ERP_READER", "CUSTOMER_ERP_WRITER"],
    documentation: [{ targetAlias: "customer_erp", sourcePath: "documentation/orders.json", mediaType: "application/json" }],
    operations: [
      { name: "read_order", targetAlias: "customer_erp", method: "GET", consequence: "read", retrySafety: "not-applicable", outcomeVerifierKey: "order_state_verifier" },
      { name: "create_order", targetAlias: "customer_erp", method: "POST", consequence: "write", retrySafety: "reconcile-before-retry", outcomeVerifierKey: "order_state_verifier" },
    ],
  };
  return { root, documentationRoot, documentation, intake, outputDirectory: path.join(root, "generated", intake.adapterId) };
}

describe("pilot adapter scaffold", () => {
  it("creates a hashed fail-closed adapter kit with all mandatory acceptance cases", () => {
    const current = fixture();
    const result = createPilotAdapterScaffold({
      intake: current.intake,
      documentationRoot: current.documentationRoot,
      outputDirectory: current.outputDirectory,
      productImport: "../../../src/product/pilot-adapter.js",
    });
    expect(result.checks.every((check) => check.passed)).toBe(true);
    expect(validatePilotAdapterDescriptor(result.descriptor).every((check) => check.passed)).toBe(true);
    expect(result.documentationLock.documents).toEqual([
      expect.objectContaining({ targetAlias: "customer_erp", bytes: Buffer.byteLength(current.documentation), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]);
    expect(fs.readFileSync(path.join(current.outputDirectory, result.documentationLock.documents[0]!.copiedPath), "utf8")).toBe(current.documentation);
    const acceptance = JSON.parse(fs.readFileSync(path.join(current.outputDirectory, "acceptance-cases.json"), "utf8")) as Array<{ caseId: string; status: string }>;
    expect(acceptance.map((item) => item.caseId)).toEqual(REQUIRED_PILOT_ADAPTER_CASES);
    expect(acceptance.every((item) => item.status === "not-run")).toBe(true);
    const adapter = fs.readFileSync(path.join(current.outputDirectory, "adapter.ts"), "utf8");
    expect(adapter).toContain('passed: false, detail: "Trusted customer scope resolver is not wired."');
    expect(adapter).not.toMatch(/passed:\s*true/);
    const boundaries = JSON.parse(fs.readFileSync(path.join(current.outputDirectory, "operation-boundaries.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(boundaries).toContainEqual(expect.objectContaining({
      operation: "create_order",
      preActionReads: ["read_order"],
      retryRule: "reconcile-before-retry",
      apiResponseAloneIsCompletionEvidence: false,
    }));
    expect(fs.readFileSync(path.join(current.outputDirectory, "customer-input-checklist.md"), "utf8"))
      .toContain("complete, not-started, partial, incorrect, and unknown external states");
    expect(result.files).toEqual(expect.arrayContaining([
      "README.md",
      "acceptance-cases.json",
      "adapter.descriptor.json",
      "adapter.ts",
      "customer-input-checklist.md",
      "documentation-lock.json",
      "documentation/01-orders.json",
      "operation-boundaries.json",
      "verifier-patterns.json",
    ]));
  });

  it("refuses to overwrite an existing scaffold", () => {
    const current = fixture();
    const options = { intake: current.intake, documentationRoot: current.documentationRoot, outputDirectory: current.outputDirectory, productImport: "./pilot-adapter.js" };
    createPilotAdapterScaffold(options);
    expect(() => createPilotAdapterScaffold(options)).toThrow(/already exists/);
  });

  it("rejects documentation traversal and symbolic links", () => {
    const current = fixture();
    const traversal = { ...current.intake, documentation: [{ ...current.intake.documentation[0]!, sourcePath: "../outside.json" }] };
    expect(() => createPilotAdapterScaffold({ intake: traversal, documentationRoot: current.documentationRoot, outputDirectory: current.outputDirectory, productImport: "./pilot-adapter.js" }))
      .toThrow(/cannot traverse/);
    const symlink = path.join(current.documentationRoot, "documentation", "linked.json");
    fs.symlinkSync(path.join(current.documentationRoot, "documentation", "orders.json"), symlink);
    expect(() => createPilotAdapterScaffold({
      intake: { ...current.intake, documentation: [{ ...current.intake.documentation[0]!, sourcePath: "documentation/linked.json" }] },
      documentationRoot: current.documentationRoot,
      outputDirectory: current.outputDirectory,
      productImport: "./pilot-adapter.js",
    })).toThrow(/non-symlink/);
  });

  it("rejects secret-shaped intake and writes without a declared read/reconciliation path", () => {
    const current = fixture();
    expect(() => pilotAdapterIntakeSchema.parse({
      ...current.intake,
      credentialAliases: ["Bearer abcdefghijklmnop"],
    })).toThrow(/credential aliases/);
    expect(() => pilotAdapterIntakeSchema.parse({
      ...current.intake,
      operations: [current.intake.operations[1]],
    })).toThrow(/requires at least one declared read/);
    expect(() => pilotAdapterIntakeSchema.parse({
      ...current.intake,
      operations: [{ ...current.intake.operations[1]!, retrySafety: "not-applicable" }],
    })).toThrow(/reconcile external state before retry/);
  });
});
