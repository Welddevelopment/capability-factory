import { normalizeApprovedOpenApiMaterial, type ApprovedOpenApiNormalizationResult } from "../../src/product/approved-openapi-normalizer.js";
import { proposeHttpBindings } from "../../src/product/http-binding-factory.js";
import type { ApprovedOpenApiMaterial } from "../../src/product/onboarding-adapter-factory.js";
import { compileAuthorityWizard } from "../../src/product/onboarding-verifier-authority.js";
import {
  CF058_COLD_CHAIN_ACTION_PATH,
  CF058_COLD_CHAIN_OBSERVER_PATH,
  CF058_COLD_CHAIN_REVIEWED_AT,
  CF058_COLD_CHAIN_TARGET_ALIAS,
  cf058ColdChainApprovedOpenApi,
  cf058ColdChainApprovedObserverOpenApi,
  cf058ColdChainAuthorityAnswers,
  cf058ColdChainBindingFacts,
  type Cf058ColdChainReviewedSource,
} from "./cf058-cold-chain-reviewed-source.js";

export interface Cf058ColdChainSplitReviewedSource extends Cf058ColdChainReviewedSource {
  observerMaterial: ApprovedOpenApiMaterial;
  observerNormalization: ApprovedOpenApiNormalizationResult;
}

function exactServerUrl(raw: string, label: string): string {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.hostname !== "localhost" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error(`CF-058 ${label} must be one exact credential-free localhost HTTPS origin.`);
  return url.toString().replace(/\/$/, "");
}

function splitMaterial(serverUrl: string, plane: "action" | "observer"): ApprovedOpenApiMaterial {
  const base = plane === "action" ? cf058ColdChainApprovedOpenApi() : cf058ColdChainApprovedObserverOpenApi(), document = structuredClone(base.document) as unknown as Record<string, unknown>;
  document.servers = [{ url: serverUrl }];
  return {
    ...base,
    materialId: `cf058_cold_chain_${plane}_v1`,
    localReference: `test/fixtures/cf058-cold-chain/${plane}-openapi-derived.json`,
    targetAlias: CF058_COLD_CHAIN_TARGET_ALIAS,
    document: document as ApprovedOpenApiMaterial["document"],
  };
}

function reviewedNormalization(material: ApprovedOpenApiMaterial, serverUrl: string, reviewer: string): ApprovedOpenApiNormalizationResult {
  const pending = normalizeApprovedOpenApiMaterial(material);
  return normalizeApprovedOpenApiMaterial(material, {
    materialDigest: pending.originalMaterialDigest,
    selectedUrl: serverUrl,
    confirmedByAlias: reviewer,
    confirmedAt: CF058_COLD_CHAIN_REVIEWED_AT,
  });
}

/**
 * Same reviewed workflow and target, but two independently approved OpenAPI
 * surfaces with distinct exact origins. No executable binding or authority is
 * created here.
 */
export function cf058ColdChainSplitReviewedSource(actionServerUrlRaw: string, observerServerUrlRaw: string): Cf058ColdChainSplitReviewedSource {
  const actionServerUrl = exactServerUrl(actionServerUrlRaw, "action origin"), observerServerUrl = exactServerUrl(observerServerUrlRaw, "observer origin");
  if (actionServerUrl === observerServerUrl) throw new Error("CF-058 action and independent observer origins must be distinct.");
  const material = splitMaterial(actionServerUrl, "action"), observerMaterial = splitMaterial(observerServerUrl, "observer");
  const normalization = reviewedNormalization(material, actionServerUrl, "cf058ActionSourceReviewer");
  const observerNormalization = reviewedNormalization(observerMaterial, observerServerUrl, "cf058ObserverSourceReviewer");
  const authorityAnswers = cf058ColdChainAuthorityAnswers(), authorityCompilation = compileAuthorityWizard(authorityAnswers), bindingFacts = cf058ColdChainBindingFacts();
  const factoryResult = proposeHttpBindings({ schemaVersion: "1.0", normalization, observerNormalization, authorityCompilation, facts: bindingFacts });
  if (factoryResult.status !== "review-required" || !factoryResult.actionBinding || !factoryResult.observerBinding || factoryResult.actionBinding.serverUrl !== actionServerUrl || factoryResult.observerBinding.serverUrl !== observerServerUrl) throw new Error("CF-058 split source failed to produce exact distinct-origin reviewed declarations.");
  return { material, observerMaterial, normalization, observerNormalization, authorityAnswers, authorityCompilation, bindingFacts, factoryResult };
}
