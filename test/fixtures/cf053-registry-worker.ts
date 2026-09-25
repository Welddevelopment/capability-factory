import { readFileSync } from "node:fs";
import { Cf053ContentAddressedCandidateRegistry, createCf053ProviderNeutralContract } from "../../src/product/local-declarative-exact-record-core.js";

const [root, contractPath, now] = process.argv.slice(2);
if (!root || !contractPath || !now) throw new Error("CF-053 registry worker arguments are incomplete.");
const body = JSON.parse(readFileSync(contractPath, "utf8"));
const contract = createCf053ProviderNeutralContract(body);
const candidate = new Cf053ContentAddressedCandidateRegistry(root).acquireDevelopment(contract, now);
process.stdout.write(`${JSON.stringify(candidate)}\n`);
