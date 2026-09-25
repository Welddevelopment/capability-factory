import fs from "node:fs";
import path from "node:path";
import { capabilityManifestSchema, type CapabilityManifest } from "./manifest.js";
import type { TraceWriter } from "./trace.js";

interface RegistryEntry {
  manifest: CapabilityManifest;
  testStatus: "passed";
  documentationHash: string;
  installCount: number;
  reuseCount: number;
  registeredAt: string;
}

interface RegistryFile {
  schemaVersion: "1";
  entries: RegistryEntry[];
}

export class CapabilityRegistry {
  private data: RegistryFile;

  constructor(
    private readonly filename: string,
    private readonly trace?: TraceWriter,
  ) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.data = fs.existsSync(filename)
      ? this.read()
      : { schemaVersion: "1", entries: [] };
  }

  register(manifest: CapabilityManifest): void {
    const parsed = capabilityManifestSchema.parse(manifest);
    const existingIndex = this.data.entries.findIndex((entry) => entry.manifest.id === parsed.id);
    const entry: RegistryEntry = {
      manifest: parsed,
      testStatus: "passed",
      documentationHash: parsed.provenance.documentationHash,
      installCount: existingIndex >= 0 ? this.data.entries[existingIndex]?.installCount ?? 0 : 0,
      reuseCount: existingIndex >= 0 ? this.data.entries[existingIndex]?.reuseCount ?? 0 : 0,
      registeredAt: new Date().toISOString(),
    };
    if (existingIndex >= 0) this.data.entries[existingIndex] = entry;
    else this.data.entries.push(entry);
    this.write();
    this.trace?.record("registry.registered", {
      capabilityId: parsed.id,
      documentationHash: parsed.provenance.documentationHash,
      testStatus: "passed",
      manifest: parsed,
    });
  }

  search(need: string): Array<{ id: string; description: string; service: string; actions: string[] }> {
    const terms = need.toLowerCase().split(/\W+/).filter((term) => term.length > 2);
    return this.data.entries
      .map((entry) => {
        const text = `${entry.manifest.id} ${entry.manifest.service} ${entry.manifest.description} ${entry.manifest.actions.map((action) => `${action.name} ${action.description}`).join(" ")}`.toLowerCase();
        const score = terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
        return { entry, score };
      })
      .filter(({ score }) => score > 0 || terms.length === 0)
      .sort((left, right) => right.score - left.score)
      .map(({ entry }) => ({
        id: entry.manifest.id,
        description: entry.manifest.description,
        service: entry.manifest.service,
        actions: entry.manifest.actions.map((action) => action.name),
      }));
  }

  install(id: string): CapabilityManifest {
    const entry = this.data.entries.find((candidate) => candidate.manifest.id === id);
    if (!entry) throw new Error(`Capability not found: ${id}`);
    if (entry.installCount > 0) entry.reuseCount += 1;
    entry.installCount += 1;
    this.write();
    this.trace?.record("registry.installed", {
      capabilityId: id,
      installCount: entry.installCount,
      reuseCount: entry.reuseCount,
    });
    return structuredClone(entry.manifest);
  }

  get(id: string): CapabilityManifest | undefined {
    const entry = this.data.entries.find((candidate) => candidate.manifest.id === id);
    return entry ? structuredClone(entry.manifest) : undefined;
  }

  list(): CapabilityManifest[] {
    return this.data.entries.map((entry) => structuredClone(entry.manifest));
  }

  private read(): RegistryFile {
    const raw = JSON.parse(fs.readFileSync(this.filename, "utf8")) as RegistryFile;
    return {
      schemaVersion: "1",
      entries: raw.entries.map((entry) => ({
        ...entry,
        manifest: capabilityManifestSchema.parse(entry.manifest),
      })),
    };
  }

  private write(): void {
    fs.writeFileSync(this.filename, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }
}
