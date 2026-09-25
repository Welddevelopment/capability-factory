import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Cf053ContentAddressedCandidateRegistry,
  createCf053AuthoritySigner,
  createCf053ProviderNeutralContract,
  launchCf053DevelopmentProcesses,
  simulateCf053DevelopmentLauncherCrash,
} from "../../src/product/local-declarative-exact-record-core.js";

const [root, contractPath, now] = process.argv.slice(2);
if (!root || !contractPath || !now) throw new Error("CF-053 crash worker requires root, contract path and time.");
const body = JSON.parse(readFileSync(contractPath, "utf8"));
const contract = createCf053ProviderNeutralContract(body);
const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry"));
const candidate = registry.acquireDevelopment(contract, now);
const signer = createCf053AuthoritySigner("cf053_crash_worker");
const processes = await launchCf053DevelopmentProcesses({ candidate, authoritySigner: signer, worldRoot: join(root, "world"), now });
await simulateCf053DevelopmentLauncherCrash(processes);
process.stdout.write(`${JSON.stringify({ candidateDigest: candidate.candidateDigest, pendingReservationLeft: true })}\n`);
