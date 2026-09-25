import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1,
  validateEffectiveUniversalityDevelopmentGate,
} from "./effective-universality-development-gate.js";

const root = process.cwd();
const validated = validateEffectiveUniversalityDevelopmentGate();
for (const file of validated.files) {
  if (!existsSync(resolve(root, file))) throw new Error(`Frozen development-gate file is missing: ${file}`);
}

console.log(JSON.stringify({
  gateId: EFFECTIVE_UNIVERSALITY_DEVELOPMENT_GATE_V1.gateId,
  representative: false,
  claim: "A pass is a frozen local development gate, not evidence of population reliability or effective universality.",
  files: validated.files.length,
  enabledFamilies: validated.enabledFamilies,
  concerns: validated.concerns,
}, null, 2));

const vitest = resolve(root, "node_modules/vitest/vitest.mjs");
const result = spawnSync(process.execPath, [vitest, "run", ...validated.files], {
  cwd: root,
  env: {
    ...process.env,
    CF_REAL_BROWSER: "0",
    CF_REAL_ERPNEXT: "0",
    CF_REAL_GITEA: "0",
    // This opt-in starts only the disposable localhost fictional EDIFACT gateway.
    CF_REAL_NETWORK_FILE: "1",
  },
  stdio: "inherit",
  shell: false,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
