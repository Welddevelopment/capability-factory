import { zodTextFormat } from "openai/helpers/zod";
import { EXPERIMENT_LIMITS } from "./config.js";
import type { CompanyDatabase } from "./database.js";
import {
  capabilityManifestFromOutput,
  capabilityManifestOutputSchema,
  hashDocumentation,
  type CapabilityManifest,
  type CapabilityManifestOutput,
} from "./manifest.js";
import type { OpenAIModelGateway } from "./model-gateway.js";
import { FACTORY_SYSTEM_PROMPT } from "./prompts.js";
import type { Scenario } from "./scenario.js";
import type { CapabilityRuntime } from "./runtime.js";
import type { TraceWriter } from "./trace.js";
import { verifyCapability } from "./verifier.js";

export class ManifestGenerator {
  constructor(
    private readonly gateway: OpenAIModelGateway,
    private readonly runtime: CapabilityRuntime,
    private readonly database: CompanyDatabase,
    private readonly trace: TraceWriter,
  ) {}

  async generate(
    need: string,
    documentation: unknown,
    scenario: Scenario,
  ): Promise<CapabilityManifest> {
    const documentationHash = hashDocumentation(documentation);
    const draftErrors: string[] = [];
    let latestDraft: CapabilityManifestOutput | null = null;
    let previousResponseError: string | null = null;
    let semanticRepairs = 0;
    let incompleteRetries = 0;
    let modelCalls = 0;
    while (semanticRepairs <= EXPERIMENT_LIMITS.maxRepairs) {
      modelCalls += 1;
      const response = await this.gateway.create({
        model: EXPERIMENT_LIMITS.model,
        reasoning: { effort: EXPERIMENT_LIMITS.reasoningEffort },
        instructions: FACTORY_SYSTEM_PROMPT,
        input: JSON.stringify({
          blockedOperation: need,
          trustedBaseUrlAlias: "procurement",
          allowedSecretAlias: scenario.contract.auth.secretAlias,
          documentationHash,
          createdAt: new Date().toISOString(),
          apiDocumentation: documentation,
          previousValidationErrors: draftErrors,
          previousDraft: latestDraft,
          previousResponseError,
        }),
        max_output_tokens: EXPERIMENT_LIMITS.maxOutputTokens,
        store: true,
        text: {
          format: zodTextFormat(capabilityManifestOutputSchema, "capability_manifest"),
        },
      });
      if (response.status !== "completed") {
        const reason = response.incomplete_details?.reason ?? "unknown reason";
        const message =
          `Model output was ${response.status} (${reason}); ` +
          "return one compact, complete manifest without padding";
        incompleteRetries += 1;
        previousResponseError = message;
        this.trace.record("capability.repair_required", {
          modelCall: modelCalls,
          semanticRepairs,
          incompleteRetries,
          category: "incomplete",
          message,
        });
        if (incompleteRetries > EXPERIMENT_LIMITS.maxRepairs) break;
        continue;
      }

      let output: CapabilityManifestOutput;
      try {
        output = capabilityManifestOutputSchema.parse(JSON.parse(response.output_text));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        previousResponseError = message.slice(0, 1_000);
        semanticRepairs += 1;
        this.trace.record("capability.repair_required", {
          modelCall: modelCalls,
          semanticRepairs,
          incompleteRetries,
          category: "validation",
          message,
        });
        continue;
      }

      latestDraft = output;
      previousResponseError = null;
      try {
        const parsed = capabilityManifestFromOutput(output, {
          documentationHash,
          model: EXPERIMENT_LIMITS.model,
          createdAt: new Date().toISOString(),
        });
        this.runtime.validateManifest(parsed);
        const verification = await verifyCapability(
          parsed,
          scenario,
          documentation,
          this.runtime,
          this.database,
          `factory-${modelCalls}`,
        );
        this.trace.record("capability.verification", {
          modelCall: modelCalls,
          semanticRepairs,
          verification,
        });
        if (!verification.passed) {
          draftErrors.splice(
            0,
            draftErrors.length,
            ...verification.checks
              .filter((check) => !check.passed)
              .map((check) => `${check.id}: ${check.detail}`),
          );
          semanticRepairs += 1;
          continue;
        }
        return parsed;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        draftErrors.splice(0, draftErrors.length, message.slice(0, 1_000));
        semanticRepairs += 1;
        this.trace.record("capability.repair_required", {
          modelCall: modelCalls,
          semanticRepairs,
          incompleteRetries,
          category: "validation",
          message,
        });
      }
    }
    const finalErrors = [
      ...draftErrors,
      ...(previousResponseError ? [previousResponseError] : []),
    ];
    throw new Error(
      `Capability generation failed after one initial attempt and ${EXPERIMENT_LIMITS.maxRepairs} repairs: ${finalErrors.join(" | ")}`,
    );
  }
}
