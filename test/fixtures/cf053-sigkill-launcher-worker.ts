import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Cf053ContentAddressedCandidateRegistry,
  createCf053AuthoritySigner,
  createCf053ProviderNeutralContract,
  adoptCf053ProcessGeneration,
  launchCf053DevelopmentProcesses,
} from "../../src/product/local-declarative-exact-record-core.js";

const [root, contractPath, now, mode = "pending"] = process.argv.slice(2);
if (!root || !contractPath || !now) throw new Error("CF-053 SIGKILL worker requires root, contract path and time.");
const contract = createCf053ProviderNeutralContract(JSON.parse(readFileSync(contractPath, "utf8")));
const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry")), candidate = registry.acquireDevelopment(contract, now), signer = createCf053AuthoritySigner("cf053_sigkill_launcher");
const processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now });
const receipt = mode === "active" ? adoptCf053ProcessGeneration(processes) : null;
process.stdout.write(`${JSON.stringify({ ready: true, candidateDigest: candidate.candidateDigest, status: mode, receiptDigest: receipt?.receiptDigest ?? null })}\n`);
setInterval(() => undefined, 10_000);
