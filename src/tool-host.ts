import type { FunctionTool } from "openai/resources/responses/responses";
import type { CompanyServerHandle } from "./company-server.js";
import type { CapabilityManifest } from "./manifest.js";
import type { CapabilityRegistry } from "./registry.js";
import { CapabilityExecutionError, type CapabilityRuntime } from "./runtime.js";
import type { Scenario } from "./scenario.js";
import type { TaskState, TaskStateStore } from "./task-state.js";
import type { TraceWriter } from "./trace.js";

const emptyParameters = { type: "object", properties: {}, required: [], additionalProperties: false };

export interface CapabilityBuilder {
  generate(need: string, documentation: unknown, scenario: Scenario): Promise<CapabilityManifest>;
}

export class ToolHost {
  private readonly installed = new Map<string, CapabilityManifest>();
  private readonly discoveredDocuments = new Map<string, unknown>();

  constructor(
    private readonly server: CompanyServerHandle,
    private readonly scenario: Scenario,
    private readonly registry: CapabilityRegistry,
    private readonly runtime: CapabilityRuntime,
    private readonly state: TaskState,
    private readonly trace: TraceWriter,
    private readonly generator?: CapabilityBuilder,
    private readonly stateStore?: TaskStateStore,
  ) {}

  definitions(): FunctionTool[] {
    const base: FunctionTool[] = [
      {
        type: "function",
        name: "list_shipments",
        description: "List incoming shipments and their operational requirements.",
        parameters: emptyParameters,
        strict: true,
      },
      {
        type: "function",
        name: "inspect_site_equipment",
        description: "Inspect equipment currently installed at a named operating site.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["siteId"],
          properties: { siteId: { type: "string", description: "Operating site identifier" } },
        },
        strict: true,
      },
      {
        type: "function",
        name: "search_capabilities",
        description: "Search the persistent capability registry before creating anything new.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["need"],
          properties: { need: { type: "string", description: "The unavailable operation" } },
        },
        strict: true,
      },
      {
        type: "function",
        name: "install_capability",
        description: "Install an approved capability returned by registry search.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["capabilityId"],
          properties: { capabilityId: { type: "string" } },
        },
        strict: true,
      },
      {
        type: "function",
        name: "search_service_docs",
        description: "Find documentation for an unavailable external operation.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["need"],
          properties: { need: { type: "string", description: "The operation requiring documentation" } },
        },
        strict: true,
      },
      {
        type: "function",
        name: "build_capability",
        description: "Generate, independently validate, and register the smallest capability needed from discovered documentation.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["need", "docsId"],
          properties: {
            need: { type: "string", description: "The blocked operation" },
            docsId: { type: "string", description: "Identifier returned by documentation search" },
          },
        },
        strict: true,
      },
      {
        type: "function",
        name: "request_human_help",
        description: "Stop safely when a legitimate route, permission, credential, or authority is unavailable.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["blocker"],
          properties: { blocker: { type: "string", description: "Exact unavoidable blocker" } },
        },
        strict: true,
      },
    ];
    for (const manifest of this.installed.values()) {
      for (const action of manifest.actions) {
        base.push({
          type: "function",
          name: action.name,
          description: action.description,
          parameters: action.inputSchema,
          strict: true,
        });
      }
    }
    return base;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<unknown> {
    this.trace.record("tool.call", { name, input });
    let output: unknown;
    switch (name) {
      case "list_shipments":
        output = await this.getJson(`${this.server.baseUrl}/shipments/v1/shipments`);
        break;
      case "inspect_site_equipment":
        output = await this.getJson(
          `${this.server.baseUrl}/warehouses/v1/warehouses/${encodeURIComponent(String(input.siteId))}/equipment`,
        );
        break;
      case "search_capabilities": {
        const need = String(input.need ?? "");
        this.state.blockedAction = need;
        this.state.requiredCapability = need;
        const matches = this.registry.search(need);
        this.state.capabilitySearchResult = matches.length > 0 ? "match" : "no_match";
        output = { matches };
        break;
      }
      case "install_capability": {
        const manifest = this.registry.install(String(input.capabilityId));
        this.installed.set(manifest.id, manifest);
        if (!this.state.installedCapabilities.includes(manifest.id)) {
          this.state.installedCapabilities.push(manifest.id);
        }
        this.state.blockedAction = null;
        this.state.requiredCapability = null;
        output = { installed: manifest.id, actions: manifest.actions.map((action) => action.name) };
        break;
      }
      case "search_service_docs": {
        if (this.state.capabilitySearchResult !== "no_match") {
          output = {
            error: true,
            category: "policy",
            message: "Search the capability registry and confirm no match before searching service docs",
          };
          break;
        }
        this.state.blockedAction = String(input.need ?? "");
        this.state.requiredCapability = String(input.need ?? "");
        const catalogue = (await this.getJson(`${this.server.baseUrl}/service-directory/v1/docs`)) as {
          documents?: Array<{ id?: unknown; description?: unknown; url?: unknown }>;
        };
        const documents: Array<{ id: string; description: string; openapi: unknown }> = [];
        for (const entry of catalogue.documents ?? []) {
          if (typeof entry.id !== "string" || typeof entry.url !== "string") continue;
          const url = new URL(entry.url, this.server.baseUrl);
          if (url.origin !== new URL(this.server.baseUrl).origin) {
            throw new Error("Service documentation catalogue returned a non-local URL");
          }
          const openapi = await this.getJson(url.toString());
          this.discoveredDocuments.set(entry.id, openapi);
          documents.push({
            id: entry.id,
            description: String(entry.description ?? "Discovered service documentation"),
            openapi,
          });
        }
        output = { documents };
        break;
      }
      case "build_capability": {
        if (!this.generator) {
          throw new Error("The model-backed Factory is paused at the unfunded API-key gate");
        }
        const docsId = String(input.docsId);
        let documentation = this.discoveredDocuments.get(docsId);
        if (!documentation) {
          const catalogue = (await this.getJson(`${this.server.baseUrl}/service-directory/v1/docs`)) as {
            documents?: Array<{ id?: unknown; url?: unknown }>;
          };
          const entry = (catalogue.documents ?? []).find((candidate) => candidate.id === docsId);
          if (entry && typeof entry.url === "string") {
            const url = new URL(entry.url, this.server.baseUrl);
            if (url.origin !== new URL(this.server.baseUrl).origin) {
              throw new Error("Service documentation catalogue returned a non-local URL");
            }
            documentation = await this.getJson(url.toString());
            this.discoveredDocuments.set(docsId, documentation);
          }
        }
        if (!documentation) throw new Error("Unknown or undiscovered documentation identifier");
        const manifest = await this.generator.generate(
          String(input.need ?? ""),
          documentation,
          this.scenario,
        );
        this.registry.register(manifest);
        output = { registered: manifest.id, actions: manifest.actions.map((action) => action.name) };
        break;
      }
      case "request_human_help":
        this.state.status = "handed_off";
        this.state.handoffReason = String(input.blocker ?? "Unspecified blocker");
        this.state.remainingWork = [];
        output = { handedOff: true, blocker: this.state.handoffReason };
        break;
      default:
        output = await this.executeInstalled(name, input);
    }
    this.state.observations.push(`${name}: ${JSON.stringify(output).slice(0, 2_000)}`);
    this.state.completedSteps.push(name);
    this.stateStore?.save(this.state);
    this.trace.record("tool.result", { name, output, taskState: this.state });
    return output;
  }

  installForScriptedRun(manifest: CapabilityManifest): void {
    this.installed.set(manifest.id, manifest);
    if (!this.state.installedCapabilities.includes(manifest.id)) {
      this.state.installedCapabilities.push(manifest.id);
    }
  }

  private async executeInstalled(name: string, input: Record<string, unknown>): Promise<unknown> {
    for (const manifest of this.installed.values()) {
      if (manifest.actions.some((action) => action.name === name)) {
        try {
          return await this.runtime.execute(manifest, name, input, { runId: this.state.runId });
        } catch (error) {
          if (error instanceof CapabilityExecutionError) {
            return { error: true, category: error.category, status: error.status ?? null, message: error.message };
          }
          throw error;
        }
      }
    }
    throw new Error(`Unknown or uninstalled tool: ${name}`);
  }

  private async getJson(url: string): Promise<unknown> {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Trusted business tool failed with HTTP ${response.status}`);
    return response.json();
  }
}
