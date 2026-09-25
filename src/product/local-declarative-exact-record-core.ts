/**
 * Canonical CF-053 development surface.
 *
 * This runtime executes only the bounded `local-declarative-exact-record-v1` primitive.
 * It does not execute a real provider SDK or provider transport and is not provider-family
 * transfer evidence. The older provider-neutral-transfer filename is retained only as a
 * compatibility implementation module while this checkpoint is under evaluation.
 */
export * from "./provider-neutral-transfer-core.js";

export {
  Cf053ContentAddressedCandidateRegistry as Cf053LocalExactRecordCandidateRegistry,
  Cf053ProductionAuthorityBroker as Cf053LocalExactRecordAuthorityBroker,
  deriveCf053ProviderNeutralContract as deriveCf053LocalExactRecordContract,
  executeCf053Transfer as executeCf053LocalExactRecord,
  launchCf053ProviderProcesses as launchCf053LocalExactRecordProcesses,
} from "./provider-neutral-transfer-core.js";

export type {
  Cf053ProviderNeutralContract as Cf053LocalExactRecordContract,
  Cf053ExecutionReceipt as Cf053LocalExactRecordExecutionReceipt,
  Cf053ProcessHandle as Cf053LocalExactRecordProcessHandle,
} from "./provider-neutral-transfer-core.js";
