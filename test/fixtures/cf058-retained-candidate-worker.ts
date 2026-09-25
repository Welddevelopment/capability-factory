import { Cf053ContentAddressedCandidateRegistry, reopenCf053DerivedContractFromDurableCandidate } from "../../src/product/local-declarative-exact-record-core.js";

const [registryRoot, workspaceTrustRoot, candidateDigest] = process.argv.slice(2);
if (!registryRoot || !workspaceTrustRoot || !candidateDigest) throw new Error("CF-058 retained-candidate worker input is incomplete.");
const derived = reopenCf053DerivedContractFromDurableCandidate({ registryRootDirectory: registryRoot, candidateDigest, workspaceTrustRootDirectory: workspaceTrustRoot });
const candidate = new Cf053ContentAddressedCandidateRegistry(registryRoot).acquire(derived, "2026-08-14T11:45:00.000Z");
process.stdout.write(`${JSON.stringify({ source: candidate.source, candidateDigest: candidate.candidateDigest })}\n`);
