import { readFileSync } from "node:fs";
import { createLocalFixtureBindingQualification } from "../../src/product/customer-local-binding-qualification.js";
import { CustomerLocalHttpAuthorityTrustStore } from "../../src/product/customer-local-http-authority-trust.js";
import { CustomerLocalTrustStore, type CustomerLocalTrustConfiguration } from "../../src/product/customer-local-trust-backup.js";
import { createCustomerLocalPinnedHttpsTransport, type CustomerLocalPinnedHttpsTransportConfig } from "../../src/product/customer-local-pinned-https-transport.js";
import { compileReviewedHttpBindings, httpBindingCompilerDigest, type CompiledHttpObservationInput, type CustomerLocalCredentialResolver } from "../../src/product/http-binding-compiler.js";
import { JsonFileGenericAcceptanceCampaignStore } from "../../src/product/generic-acceptance-executor.js";
import { cf058ColdChainSplitReviewedSource } from "./cf058-cold-chain-runtime-source.js";
import { CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS, CF058_COLD_CHAIN_ACTION_DRIVER, CF058_COLD_CHAIN_ACTION_OPERATION, CF058_COLD_CHAIN_ACTION_PATH, CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS, CF058_COLD_CHAIN_OBSERVER_DRIVER, CF058_COLD_CHAIN_OBSERVER_OPERATION, CF058_COLD_CHAIN_OBSERVER_PATH, CF058_COLD_CHAIN_OBSERVER_SOURCE } from "./cf058-cold-chain-reviewed-source.js";

interface Input {
  campaignRoot: string;
  campaignId: string;
  tenantId: string;
  actionServerUrl: string;
  observerServerUrl: string;
  actionCertificatePem: string;
  actionCertificateSha256: string;
  observerCertificatePem: string;
  observerCertificateSha256: string;
  qualifiedAt: string;
  expiresAt: string;
  trustStatePath: string;
  authorityTrustStatePath: string;
  trustConfiguration: CustomerLocalTrustConfiguration;
  workspaceId: string;
  initialAdminKeyId: string;
  authorityContractDigest: string;
  observation: CompiledHttpObservationInput;
}

const inputPath = process.argv[2];
if (!inputPath) throw new Error("CF-058 restart worker requires one exact local input path.");
const input = JSON.parse(readFileSync(inputPath, "utf8")) as Input;
const actionCredential = process.env.CF058_ACTION_TOKEN, observerCredential = process.env.CF058_OBSERVER_TOKEN;
if (!actionCredential || !observerCredential) throw new Error("CF-058 restart worker credential aliases are unresolved.");

const campaign = await new JsonFileGenericAcceptanceCampaignStore(input.campaignRoot).load(input.campaignId);
const restartCase = campaign?.cases.find((item) => item.caseId === "sidecar-restart");
if (!campaign || !["running", "awaiting-reconciliation"].includes(campaign.status) || restartCase?.status !== "reconciliation-required" || campaign.cases.slice(0, 7).some((item) => item.status !== "passed")) throw new Error("CF-058 restart worker did not reopen the exact interrupted campaign boundary.");

const trustStore = new CustomerLocalTrustStore(input.trustStatePath, input.trustConfiguration);
const authorityTrustStore = new CustomerLocalHttpAuthorityTrustStore({ statePath: input.authorityTrustStatePath, workspaceId: input.workspaceId, initialAdminKeyId: input.initialAdminKeyId, trustStore });
try {
  const activation = authorityTrustStore.resolveCurrent(input.authorityContractDigest);
  const reviewed = cf058ColdChainSplitReviewedSource(input.actionServerUrl, input.observerServerUrl);
  const resolver: CustomerLocalCredentialResolver = {
    resolverId: "cf058_credential_resolver",
    implementationDigest: httpBindingCompilerDigest("cf058 credential resolver v1"),
    allowedAliases: [CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS, CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS],
    async resolve(alias: string) { return alias === CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS ? { alias, value: actionCredential } : alias === CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS ? { alias, value: observerCredential } : null; },
  };
  const actionConfig: CustomerLocalPinnedHttpsTransportConfig = { driverId: CF058_COLD_CHAIN_ACTION_DRIVER, sourceId: "cf058_action_source", serverUrl: input.actionServerUrl, supportedMethods: ["PUT"], independentlyAuthenticated: true, independentFromDriverIds: [], credentialAlias: CF058_COLD_CHAIN_ACTION_CREDENTIAL_ALIAS, reviewedOperations: [{ operationId: CF058_COLD_CHAIN_ACTION_OPERATION, method: "PUT", pathTemplate: CF058_COLD_CHAIN_ACTION_PATH, declarationDigest: reviewed.factoryResult.actionBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: input.actionCertificatePem, serverCertificateSha256: input.actionCertificateSha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 65_536, maximumResponseBytes: 65_536, maximumResponseHeaders: 32, maximumRequestsPerMinute: 120 };
  const actionTransport = createCustomerLocalPinnedHttpsTransport(actionConfig);
  const observerTransport = createCustomerLocalPinnedHttpsTransport({ driverId: CF058_COLD_CHAIN_OBSERVER_DRIVER, sourceId: CF058_COLD_CHAIN_OBSERVER_SOURCE, serverUrl: input.observerServerUrl, supportedMethods: ["GET"], independentlyAuthenticated: true, independentFromDriverIds: [CF058_COLD_CHAIN_ACTION_DRIVER], credentialAlias: CF058_COLD_CHAIN_OBSERVER_CREDENTIAL_ALIAS, reviewedOperations: [{ operationId: CF058_COLD_CHAIN_OBSERVER_OPERATION, method: "GET", pathTemplate: CF058_COLD_CHAIN_OBSERVER_PATH, declarationDigest: reviewed.factoryResult.observerBinding!.declarationDigest }], authorizationScheme: "Bearer", caCertificatePem: input.observerCertificatePem, serverCertificateSha256: input.observerCertificateSha256, timeoutMilliseconds: 1_000, maximumRequestBytes: 65_536, maximumResponseBytes: 65_536, maximumResponseHeaders: 32, maximumRequestsPerMinute: 240 });
  const qualification = createLocalFixtureBindingQualification({ tenantId: input.tenantId, sessionId: "cf058_final", packageDigest: httpBindingCompilerDigest("cf058 final package"), sourceDigest: reviewed.normalization.normalizationReceiptDigest, factoryResult: reviewed.factoryResult, actionTransport, observerTransport, credentialResolver: resolver, qualifiedAt: input.qualifiedAt, expiresAt: input.expiresAt });
  const pair = compileReviewedHttpBindings({ factoryResult: reviewed.factoryResult, actionTransport, observerTransport, credentialResolver: resolver, primitiveRegistryDigest: httpBindingCompilerDigest("cf058 primitives"), verifierRegistryDigest: httpBindingCompilerDigest("cf058 verifiers"), qualifiedAt: input.qualifiedAt, expiresAt: input.expiresAt, customerLocalQualification: qualification });
  const observed = await pair.observer.observe(input.observation);
  process.stdout.write(`${JSON.stringify({ classification: observed.classification, activationReceiptDigest: activation.activationReceiptDigest, campaignRevision: campaign.revision, observerImplementationDigest: pair.observer.implementationDigest, observerDeclarationDigest: pair.observer.declarationDigest, observerQualificationDigest: pair.observer.qualification.qualificationDigest, observerTransportImplementationDigest: observerTransport.implementationDigest })}\n`);
} finally {
  authorityTrustStore.close();
  trustStore.close();
}
