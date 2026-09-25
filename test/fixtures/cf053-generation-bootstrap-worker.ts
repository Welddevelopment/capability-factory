import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Cf053ContentAddressedCandidateRegistry,
  createCf053ProviderNeutralContract,
  recoverCf053AbandonedPendingGeneration,
} from "../../src/product/local-declarative-exact-record-core.js";

const [root, contractPath, now] = process.argv.slice(2);
if (!root || !contractPath || !now) throw new Error("CF-053 generation bootstrap worker requires root, contract path and time.");
const contract = createCf053ProviderNeutralContract(JSON.parse(readFileSync(contractPath, "utf8")));
const registry = new Cf053ContentAddressedCandidateRegistry(join(root, "registry"));
const candidate = registry.acquireDevelopment(contract, now);
const recovered = recoverCf053AbandonedPendingGeneration({ candidate, worldRoot: join(root, "world") });
process.stdout.write(`${JSON.stringify({ candidateDigest: candidate.candidateDigest, recovered })}\n`);
