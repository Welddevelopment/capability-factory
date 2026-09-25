import type { BroadGoalRunResult } from "./broad-goal-sdk.js";
import {
  capabilityModeDescriptorSchema,
  capabilityModeEnvelopeSchema,
  capabilityModeResultSchema,
  type CapabilityMode,
  type CapabilityModeDescriptor,
  type CapabilityModeEnvelope,
  type CapabilityModeResult,
} from "./capability-mode-contract.js";
import type {
  BrowserCapabilityGoalResult,
  ExperimentalBrowserCapabilitySdk,
} from "../experimental/browser-capability-sdk.js";
import type {
  ExperimentalFileTransferCapabilitySdk,
  FileTransferCapabilityGoalResult,
} from "../experimental/file-transfer-capability-sdk.js";
import type {
  ExperimentalInboxMessageCapabilitySdk,
  InboxMessageCapabilityGoalResult,
} from "../experimental/inbox-message-capability-sdk.js";
import type {
  DocumentCapabilityGoalResult,
  ExperimentalDocumentCapabilitySdk,
} from "../experimental/document-capability-sdk.js";
import type {
  DatabaseCapabilityGoalResult,
  ExperimentalDatabaseCapabilitySdk,
} from "../experimental/database-capability-sdk.js";
import type {
  ExperimentalTrustedToolCapabilitySdk,
  TrustedToolGoalResult,
} from "../experimental/trusted-tool-sandbox.js";
import type {
  AgentDelegationGoalResult,
  ExperimentalAgentDelegationCapabilitySdk,
} from "../experimental/agent-delegation-capability-sdk.js";

export interface CapabilityModeRunner {
  readonly descriptor: CapabilityModeDescriptor;
  run(envelope: CapabilityModeEnvelope): Promise<CapabilityModeResult>;
}

function summaryFromParent(result: unknown, fallback: string): {
  parentResumed: boolean;
  parentCompleted: boolean;
  summary: string;
} {
  if (!result || typeof result !== "object") {
    return { parentResumed: false, parentCompleted: false, summary: fallback };
  }
  const parent = (result as { parent?: unknown }).parent;
  if (!parent || typeof parent !== "object") {
    return { parentResumed: false, parentCompleted: false, summary: fallback };
  }
  const record = parent as Record<string, unknown>;
  return {
    parentResumed: record.resumed === true,
    parentCompleted: record.completed === true,
    summary: typeof record.summary === "string" && record.summary.length > 0
      ? record.summary
      : fallback,
  };
}

function experimentalResult(
  capabilityMode: Exclude<CapabilityMode, "constrained-http-api">,
  result:
    | BrowserCapabilityGoalResult
    | FileTransferCapabilityGoalResult
    | InboxMessageCapabilityGoalResult
    | DocumentCapabilityGoalResult
    | DatabaseCapabilityGoalResult
    | TrustedToolGoalResult
    | AgentDelegationGoalResult,
): CapabilityModeResult {
  const parent = summaryFromParent(result, "The customer-local mode stopped without verified parent-goal completion.");
  return capabilityModeResultSchema.parse({
    capabilityMode,
    status: result.status,
    ...parent,
    ...("path" in result && result.path ? { acquisitionPath: result.path } : {}),
    ...("capabilityId" in result && result.capabilityId ? { capabilityId: result.capabilityId } : {}),
  });
}

function httpResult(result: BroadGoalRunResult): CapabilityModeResult {
  if (result.status === "handoff") {
    return {
      capabilityMode: "constrained-http-api",
      status: "handoff",
      parentResumed: false,
      parentCompleted: false,
      summary: result.handoff.summary,
    };
  }
  if (result.status === "plan-rejected") {
    return {
      capabilityMode: "constrained-http-api",
      status: "plan-rejected",
      parentResumed: false,
      parentCompleted: false,
      summary: "Trusted planning rejected the proposed work before execution.",
    };
  }
  const completed = result.status === "completed";
  return {
    capabilityMode: "constrained-http-api",
    status: result.status === "active" ? "unknown" : result.status,
    parentResumed: completed,
    parentCompleted: completed,
    summary: completed
      ? "The constrained HTTP parent goal resumed and completed after aggregate external-state verification."
      : "The constrained HTTP parent goal did not reach verified completion.",
  };
}

function descriptor(input: CapabilityModeDescriptor): CapabilityModeDescriptor {
  return capabilityModeDescriptorSchema.parse({ ...input, configured: true });
}

export function createHttpModeRunner(
  runner: { completeGoal(request: Extract<CapabilityModeEnvelope, { capabilityMode: "constrained-http-api" }>["request"]): Promise<BroadGoalRunResult> },
): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "constrained-http-api",
      label: "Constrained HTTP API",
      driverVersion: "broad-goal-http-v1",
      maturity: "working-local-pilot-mvp",
      configured: true,
      claimBoundary: "Working local pilot MVP for tightly scoped constrained HTTP APIs; not customer-production validated.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "constrained-http-api") throw new Error("HTTP runner received a different capability mode.");
      return httpResult(await runner.completeGoal(envelope.request));
    },
  };
}

export function createBrowserModeRunner(sdk: ExperimentalBrowserCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-browser-actions",
      label: "Authenticated browser actions",
      driverVersion: "browser-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Bounded local Chromium experiment with explicit UI contracts; not pilot-ready or generally compatible.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-browser-actions") throw new Error("Browser runner received a different capability mode.");
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal(envelope.request));
    },
  };
}

export function createFileTransferModeRunner(sdk: ExperimentalFileTransferCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-file-transfer-actions",
      label: "File and EDI actions",
      driverVersion: "file-transfer-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Bounded local X12 850 and authenticated-network EDIFACT experiments; not general EDI or production transfer support.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-file-transfer-actions") throw new Error("File runner received a different capability mode.");
      const { simulateLostResponseAfterCommit, ...request } = envelope.request;
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal({
        ...request,
        ...(simulateLostResponseAfterCommit === undefined ? {} : { simulateLostResponseAfterCommit }),
      }));
    },
  };
}

export function createInboxMessageModeRunner(sdk: ExperimentalInboxMessageCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-inbox-message-actions",
      label: "Inbox message actions",
      driverVersion: "inbox-message-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Bounded signed customer-local webhook or local trusted-ingress plaintext order experiment; not a general messaging or email agent.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-inbox-message-actions") throw new Error("Inbox runner received a different capability mode.");
      const { simulateLostResponseAfterCommit, ...request } = envelope.request;
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal({
        ...request,
        ...(simulateLostResponseAfterCommit === undefined ? {} : { simulateLostResponseAfterCommit }),
      }));
    },
  };
}

export function createDocumentModeRunner(sdk: ExperimentalDocumentCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-document-actions",
      label: "Machine-readable document actions",
      driverVersion: "document-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Two bounded local one-page machine-readable PDF layouts; not OCR or general document automation.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-document-actions") throw new Error("Document runner received a different capability mode.");
      const { simulateLostResponseAfterCommit, ...request } = envelope.request;
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal({
        ...request,
        ...(simulateLostResponseAfterCommit === undefined ? {} : { simulateLostResponseAfterCommit }),
      }));
    },
  };
}

export function createDatabaseModeRunner(sdk: ExperimentalDatabaseCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-database-actions",
      label: "Reviewed database operations",
      driverVersion: "database-driver-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Bounded local reviewed-operation experiment; not arbitrary SQL or production database access.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-database-actions") throw new Error("Database runner received a different capability mode.");
      const { simulateLostResponseAfterCommit, ...request } = envelope.request;
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal({
        ...request,
        ...(simulateLostResponseAfterCommit === undefined ? {} : { simulateLostResponseAfterCommit }),
      }));
    },
  };
}

export function createTrustedToolModeRunner(sdk: ExperimentalTrustedToolCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-trusted-tool-actions",
      label: "Pinned trusted tools and isolated residual compute",
      driverVersion: "trusted-tool-wasm-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Import-free pinned WebAssembly compute in a killable local worker; not general package installation or arbitrary code execution.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-trusted-tool-actions") throw new Error("Trusted-tool runner received a different capability mode.");
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal(envelope.request));
    },
  };
}

export function createAgentDelegationModeRunner(sdk: ExperimentalAgentDelegationCapabilitySdk): CapabilityModeRunner {
  return {
    descriptor: descriptor({
      capabilityMode: "experimental-agent-delegation-actions",
      label: "Signed agent and digital-service delegation",
      driverVersion: "signed-agent-delegation-v0.1",
      maturity: "experimental-local",
      configured: true,
      claimBoundary: "Pinned signed local delegate with separate external-outcome verification; not open-ended agent discovery or production delegation.",
    }),
    async run(envelope) {
      if (envelope.capabilityMode !== "experimental-agent-delegation-actions") throw new Error("Agent-delegation runner received a different capability mode.");
      const { simulateLostResponseAfterCommit, ...request } = envelope.request;
      return experimentalResult(envelope.capabilityMode, await sdk.completeGoal({
        ...request,
        ...(simulateLostResponseAfterCommit === undefined ? {} : { simulateLostResponseAfterCommit }),
      }));
    },
  };
}

/**
 * Trusted mode selection is upstream. This router validates an explicit
 * discriminated envelope and never infers a driver from untrusted payload data.
 */
export class CapabilityModeRouter {
  private readonly runners = new Map<CapabilityMode, CapabilityModeRunner>();

  constructor(runners: CapabilityModeRunner[]) {
    for (const runner of runners) {
      const mode = runner.descriptor.capabilityMode;
      if (this.runners.has(mode)) throw new Error(`Duplicate capability-mode runner: ${mode}`);
      this.runners.set(mode, runner);
    }
  }

  descriptors(): CapabilityModeDescriptor[] {
    return [...this.runners.values()]
      .map((runner) => structuredClone(runner.descriptor))
      .sort((left, right) => left.capabilityMode.localeCompare(right.capabilityMode));
  }

  async execute(rawEnvelope: unknown): Promise<CapabilityModeResult> {
    const envelope = capabilityModeEnvelopeSchema.parse(rawEnvelope);
    const runner = this.runners.get(envelope.capabilityMode);
    if (!runner) throw new Error(`Capability mode is not configured: ${envelope.capabilityMode}`);
    if (runner.descriptor.capabilityMode !== envelope.capabilityMode) {
      throw new Error("Capability-mode registry mismatch.");
    }
    const result = await runner.run(envelope);
    if (result.capabilityMode !== envelope.capabilityMode) {
      throw new Error("Capability-mode result crossed a driver boundary.");
    }
    return capabilityModeResultSchema.parse(result);
  }
}
