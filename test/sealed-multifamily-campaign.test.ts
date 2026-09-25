import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSealedMultifamilyCampaign } from "../src/product/sealed-multifamily-campaign.js";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sealDirectory = join(repositoryRoot, "validation", "sealed-multifamily-campaign-v2");

describe("CF-006 sealed unfamiliar multi-family campaign", () => {
  it("preserves the counted v2 seal and refuses to rerun it after the compiler contract evolves", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-006-sealed-"));
    try {
      await expect(runSealedMultifamilyCampaign({ sealDirectory, workingDirectory: join(root, "world") }))
        .rejects.toThrow(/sealed implementation .* changed after unsealing/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed before execution when any sealed byte changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "cf-006-seal-tamper-"));
    try {
      const copiedSeal = join(root, "seal");
      const { cpSync, appendFileSync } = await import("node:fs");
      cpSync(sealDirectory, copiedSeal, { recursive: true });
      appendFileSync(join(copiedSeal, "fixture.json"), " ");
      await expect(runSealedMultifamilyCampaign({ sealDirectory: copiedSeal, workingDirectory: join(root, "world") }))
        .rejects.toThrow(/changed after (precommitment|unsealing)/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
