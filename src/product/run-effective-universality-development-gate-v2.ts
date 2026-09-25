import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2, validateEffectiveUniversalityDevelopmentGateV2 } from "./effective-universality-development-gate-v2.js";

const root = process.cwd();
const validated = validateEffectiveUniversalityDevelopmentGateV2();
for (const file of validated.files) if (!existsSync(resolve(root, file))) throw new Error(`Frozen v2 development-gate file is missing: ${file}`);
console.log(JSON.stringify({
  gateId: EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V2.gateId,
  representative: false,
  claim: "A pass is a frozen local development gate, not evidence of population reliability or effective universality.",
  files: validated.files.length,
  enabledFamilies: validated.enabledFamilies,
  concerns: validated.concerns,
}, null, 2));
const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", "--no-file-parallelism", ...validated.files], {
  cwd: root,
  env: { ...process.env, CF_REAL_BROWSER: "1", CF_REAL_ERPNEXT: "0", CF_REAL_GITEA: "0", CF_REAL_NETWORK_FILE: "1" },
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
