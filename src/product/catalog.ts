import { capabilityManifestSchema, type CapabilityManifest } from "../manifest.js";
import type { CapabilityRequest } from "./contracts.js";
import type { TrustedCapabilityCandidate, TrustedCapabilitySource } from "./coordinator.js";

export interface TrustedCatalogEntry {
  referenceId: string;
  needKey: string;
  manifest: CapabilityManifest;
  trust: "customer-approved" | "vendor-reviewed" | "untrusted";
  enabled: boolean;
}

/**
 * Provider-neutral local catalog adapter. Real provider adapters should map into
 * this interface; catalog presence never bypasses coordinator policy or verification.
 */
export class ConfiguredTrustedCatalog implements TrustedCapabilitySource {
  readonly id: string;
  private readonly entries: TrustedCatalogEntry[];

  constructor(id: string, entries: TrustedCatalogEntry[]) {
    if (!/^[a-z][a-z0-9-]{2,63}$/.test(id)) throw new Error("Invalid trusted catalog ID");
    this.id = id;
    this.entries = entries.map((entry) => ({
      ...structuredClone(entry),
      manifest: capabilityManifestSchema.parse(entry.manifest),
    }));
  }

  async search(request: CapabilityRequest): Promise<TrustedCapabilityCandidate[]> {
    return this.entries
      .filter(
        (entry) =>
          entry.enabled &&
          entry.trust !== "untrusted" &&
          entry.needKey === request.need.key,
      )
      .map((entry) => ({ referenceId: entry.referenceId, manifest: structuredClone(entry.manifest) }));
  }
}
