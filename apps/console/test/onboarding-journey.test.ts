import { describe, expect, it } from "vitest";
import { projectAssistedOnboarding, type OnboardingArtifactSummary } from "../server/onboarding-journey.js";
import { createConsoleApp } from "../server/app.js";

const confirmed = (summary: string): OnboardingArtifactSummary => ({ state: "confirmed", summary, blockers: [] });

describe("assisted onboarding projection", () => {
  it("keeps an empty journey fail closed", () => {
    const projection = projectAssistedOnboarding(undefined);
    expect(projection.summary).toMatchObject({ completed: 0, total: 7, blocked: 0 });
    expect(projection.preparationReady).toBe(false);
    expect(projection.activated).toBe(false);
    expect(projection.stages[0]?.blockers).toContain("reviewed-artifact-not-attached");
  });

  it("can reach preparation readiness but never silently activates", () => {
    const projection = projectAssistedOnboarding({
      blockedWorkflow: confirmed("Stable blocked-context contract reviewed."),
      approvedSystemMaterial: confirmed("Approved local sources are hash locked."),
      proposedOperations: confirmed("Operation inventory reviewed."),
      authorityContract: confirmed("Consequential boundaries explicitly confirmed."),
      outcomeContract: confirmed("Independent observable completion confirmed."),
      adapterAndVerifier: confirmed("Remaining implementation blockers resolved."),
      acceptancePlan: confirmed("Executable evidence is attached for separate readiness review."),
    });
    expect(projection.preparationReady).toBe(true);
    expect(projection.activated).toBe(false);
    expect(projection.boundary).toMatch(/does not activate/);
  });

  it("surfaces provenance and blockers instead of flattening proposals into facts", () => {
    const projection = projectAssistedOnboarding({
      proposedOperations: {
        state: "review-required",
        summary: "Three extracted operations and one proposed classification.",
        blockers: ["write-classification-needs-confirmation"],
        provenance: { observed: 0, extracted: 3, inferredProposal: 1, customerConfirmed: 0, independentlyVerified: 0, unknown: 1 },
      },
    });
    const operations = projection.stages.find((stage) => stage.id === "operations");
    expect(operations?.status).toBe("blocked");
    expect(operations?.provenance?.inferredProposal).toBe(1);
    expect(operations?.blockers).toContain("write-classification-needs-confirmation");
  });

  it("refuses to count a nominally confirmed artifact that still has a blocker", () => {
    const projection = projectAssistedOnboarding({
      blockedWorkflow: { state: "confirmed", summary: "Conflicting input.", blockers: ["owner-not-confirmed"] },
      approvedSystemMaterial: confirmed("Approved."),
      proposedOperations: confirmed("Approved."),
      authorityContract: confirmed("Approved."),
      outcomeContract: confirmed("Approved."),
      adapterAndVerifier: confirmed("Approved."),
      acceptancePlan: confirmed("Approved."),
    });
    expect(projection.stages[0]?.status).toBe("blocked");
    expect(projection.summary.completed).toBe(6);
    expect(projection.preparationReady).toBe(false);
  });

  it("exposes the fail-closed journey through the private console API", async () => {
    const { app } = createConsoleApp({
      onboardingJourney: {
        blockedWorkflow: confirmed("Blocked-context contract reviewed."),
        proposedOperations: {
          state: "review-required",
          summary: "Operation proposal awaits a consequential review.",
          blockers: ["write-classification-needs-confirmation"],
        },
      },
    });
    const response = await app.inject({ method: "GET", url: "/api/onboarding-journey" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      posture: "assisted-onboarding-private-alpha",
      preparationReady: false,
      activated: false,
      summary: { completed: 1, total: 7 },
    });
    const page = await app.inject({ method: "GET", url: "/onboarding" });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("Assisted onboarding");
    await app.close();
  });
});
