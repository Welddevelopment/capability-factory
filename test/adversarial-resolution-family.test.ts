import { appendFileSync, cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditAuthorAuthoredBridges, runAdversarialResolutionFamily } from "../src/product/adversarial-resolution-family.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const materialDirectory = join(root, "validation", "cf-014-adversarial-family-v1");

describe("CF-014 adversarial unfamiliar goal family", () => {
  it("runs the sealed structurally different multi-family goals through reusable primitives", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cf-014-dry-"));
    try {
      const receipt = await runAdversarialResolutionFamily({ materialDirectory, workingDirectory: join(temporary, "run"), requireSeal: true });
      expect(receipt.aggregate).toEqual({ goalsCompleted: 2, goalCount: 2, workItemsCompleted: 7, workItemCount: 7, incorrectSideEffects: 0 });
      expect(receipt.cases.map((item) => item.topology)).toEqual(["chain", "fork-join"]);
      expect(receipt.cases.every((item) => item.runtimeEvidence.every((family) => family.qualificationControls === 11))).toBe(true);
      expect(receipt.cases.every((item) => item.authorBridge.caseSpecificSourceFiles === 0 && item.authorBridge.postUnsealCallbacks === 0)).toBe(true);
      expect(receipt.baseline).toMatchObject({ goalsCompleted: 1, goalCount: 2, primitiveCoveredWorkItems: 7, executableWorkItems: 3, totalWorkItems: 7 });
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("fails closed before execution when sealed family material changes", async () => {
    const temporary = mkdtempSync(join(tmpdir(), "cf-014-tamper-"));
    try {
      const copied = join(temporary, "material");
      cpSync(materialDirectory, copied, { recursive: true });
      appendFileSync(join(copied, "family.json"), " ");
      await expect(runAdversarialResolutionFamily({ materialDirectory: copied, workingDirectory: join(temporary, "run"), requireSeal: true }))
        .rejects.toThrow(/sealed adversarial material changed/i);
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  });

  it("turns case-specific code and incomplete reusable declarations into precise bridge blockers", () => {
    expect(auditAuthorAuthoredBridges({ caseSpecificSourceFile: "author-only.ts" })).toMatchObject({ ready: false, blockers: expect.arrayContaining([expect.stringMatching(/case-specific-source/)]) });
    expect(auditAuthorAuthoredBridges({
      caseId: "blocked-case", ordinaryGoal: "Blocked", identity: { tenantId: "t", requestId: "r", parentGoalId: "g" },
      authority: { targetAliases: ["generic-record-outbox"], actionKeys: ["write-record-file"], approvalKeys: ["approve-record-file"], maximumRisk: "reversible-write" },
      record: { recordId: "BR-1", subjectCode: "blocked", unitCount: 1, stage: "approved", branches: [], authorityRef: "a" }, initialRows: [], initialFiles: [],
      workItems: [{ workItemId: "write", primitiveKey: "generic-file.record-transform-v1", dependsOn: [], inputs: [{ inputKey: "record", kind: "trusted-evidence", valueKey: "approved-record" }] }],
      terminal: { workItemId: "write", outputKey: "record" }, fault: { restartAfterCommitWorkItemId: "write", loseParentResponse: true },
    })).toMatchObject({ ready: false, blockers: expect.arrayContaining(["missing-reusable-file-transform:write"]) });
  });
});
