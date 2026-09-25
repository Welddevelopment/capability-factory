import path from "node:path";
import {
  RotatingMemorySecretProvider,
  type LocalSecretProvider,
  type ScopedSecretDescriptor,
  type SecretScope,
} from "../product/secrets.js";
import { createBrowserModeRunner, type CapabilityModeRunner } from "../product/capability-mode-router.js";
import {
  ExperimentalBrowserCapabilitySdk,
  StaticTrustedBrowserCapabilitySource,
  type BrowserCapabilityGoalRequest,
} from "../experimental/browser-capability-sdk.js";
import {
  ExperimentalBrowserDriver,
  type ExperimentalBrowserOutcomeVerifier,
  type ExperimentalBrowserTarget,
} from "../experimental/browser-driver.js";
import { PlaywrightBrowserSessionFactory } from "../experimental/playwright-browser-session.js";
import { FileBrowserCapabilityRegistry } from "../experimental/browser-registry.js";
import {
  TrustedUiContractBrowserCapabilityBuilder,
  defineTrustedBrowserUiContract,
  type BrowserCapabilityBuilder,
} from "../experimental/browser-ui-contract.js";
import { type RealGiteaWorld } from "./real-gitea-world.js";

const USERNAME_ALIAS = "gitea_browser_username";
const PASSWORD_ALIAS = "gitea_browser_password";
const TARGET_ALIAS = "gitea_browser";

export const REAL_GITEA_BROWSER_SECRET_DESCRIPTORS: ScopedSecretDescriptor[] = [
  {
    alias: USERNAME_ALIAS,
    version: "gitea-local-v1",
    scope: {
      targetAliases: [TARGET_ALIAS],
      actionNames: ["browser-capability-verification", "browser-write"],
      methods: ["BROWSER"],
    },
  },
  {
    alias: PASSWORD_ALIAS,
    version: "gitea-local-v1",
    scope: {
      targetAliases: [TARGET_ALIAS],
      actionNames: ["browser-capability-verification", "browser-write"],
      methods: ["BROWSER"],
    },
  },
];

const exactLabel = (value: string) => ({ kind: "label" as const, value, exact: true as const });
const exactPlaceholder = (value: string) => ({ kind: "placeholder" as const, value, exact: true as const });
const exactRole = (role: "button" | "link" | "heading", name: string) => ({
  kind: "role" as const,
  role,
  name,
  exact: true as const,
});

export const REAL_GITEA_BROWSER_UI_CONTRACT = defineTrustedBrowserUiContract({
  schemaVersion: "1.0",
  contractId: "gitea-issue-ui-v1",
  capabilityId: "gitea-create-issue-browser-v1",
  needKey: "create-gitea-issue-through-ui",
  targetAlias: TARGET_ALIAS,
  outcomeVerifierKey: "gitea-independent-admin-api-browser-v1",
  authentication: {
    kind: "session-form",
    path: "/user/login",
    assertions: [{ locator: exactRole("heading", "Sign In"), expectedText: "Sign In" }],
    fields: [
      { source: "secret", locator: exactLabel("Username or Email Address"), secretAlias: USERNAME_ALIAS },
      { source: "secret", locator: exactLabel("Password"), secretAlias: PASSWORD_ALIAS },
    ],
    submit: exactRole("button", "Sign In"),
    secretAliases: [USERNAME_ALIAS, PASSWORD_ALIAS],
  },
  workPage: {
    path: "/cf-admin/cf-incident-intake/issues/new",
    assertions: [{ locator: exactRole("link", "cf-incident-intake"), expectedText: "cf-incident-intake" }],
    fields: [
      { source: "input", locator: exactPlaceholder("Title"), inputKey: "title" },
      { source: "input", locator: exactLabel("Leave a comment"), inputKey: "body" },
    ],
    submit: exactRole("button", "Create Issue"),
    approvalKey: "create-gitea-issue",
    confirmation: {
      locator: { kind: "role", role: "main" },
      expectedInputKey: "title",
    },
  },
});

function target(world: RealGiteaWorld): ExperimentalBrowserTarget {
  return {
    origin: world.baseUrl,
    allowedNavigationPaths: [
      REAL_GITEA_BROWSER_UI_CONTRACT.authentication.kind === "session-form"
        ? REAL_GITEA_BROWSER_UI_CONTRACT.authentication.path
        : "/user/login",
      REAL_GITEA_BROWSER_UI_CONTRACT.workPage.path,
    ],
    allowedRequests: [
      { path: "/user/login", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/user/login", method: "POST", purpose: "session-auth", maxPerSession: 1 },
      { path: "/", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/cf-admin/-/heatmap", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/repo/search", query: "?count_only=1&uid=1&team_id=0&q=&page=1&mode=", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/repo/search", query: "?sort=updated&order=desc&uid=1&team_id=0&q=&page=1&limit=15&mode=&archived=false", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/cf-admin/cf-incident-intake/issues/new", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/cf-admin/cf-incident-intake/issues/new", method: "POST", purpose: "business-write", maxPerSession: 1 },
      { path: "/cf-admin/cf-incident-intake/issues/:integer", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/cf-admin/cf-incident-intake/issues/:integer/content-history/overview", method: "GET", purpose: "read", maxPerSession: 1 },
      { path: "/assets/js/:asset", method: "GET", purpose: "read", maxPerSession: 200 },
    ],
    allowedLocators: [
      ...REAL_GITEA_BROWSER_UI_CONTRACT.authentication.kind === "session-form"
        ? [
            ...REAL_GITEA_BROWSER_UI_CONTRACT.authentication.assertions.map((item) => item.locator),
            ...REAL_GITEA_BROWSER_UI_CONTRACT.authentication.fields.map((item) => item.locator),
            REAL_GITEA_BROWSER_UI_CONTRACT.authentication.submit,
          ]
        : [],
      ...REAL_GITEA_BROWSER_UI_CONTRACT.workPage.assertions.map((item) => item.locator),
      ...REAL_GITEA_BROWSER_UI_CONTRACT.workPage.fields.map((item) => item.locator),
      REAL_GITEA_BROWSER_UI_CONTRACT.workPage.submit,
      REAL_GITEA_BROWSER_UI_CONTRACT.workPage.confirmation.locator,
    ].map((locator) => ({ ...locator })),
    blockedResourceTypes: ["stylesheet", "image", "font", "media"],
    timeoutMs: 10_000,
  };
}

function secrets(
  world: RealGiteaWorld,
  override: Partial<{ username: string; password: string }> = {},
): RotatingMemorySecretProvider {
  const provider = new RotatingMemorySecretProvider();
  const credentials = { ...world.browserSessionCredentials(), ...override };
  const scope: SecretScope = {
    targetAliases: [TARGET_ALIAS],
    actionNames: ["browser-capability-verification", "browser-write"],
    methods: ["BROWSER"],
  };
  provider.set({ alias: USERNAME_ALIAS, version: "gitea-local-v1", scope }, credentials.username);
  provider.set({ alias: PASSWORD_ALIAS, version: "gitea-local-v1", scope }, credentials.password);
  return provider;
}

export class RealGiteaBrowserWorld {
  private readonly sdk: ExperimentalBrowserCapabilitySdk;

  constructor(
    readonly world: RealGiteaWorld,
    readonly dataDirectory: string,
    credentialOverride: Partial<{ username: string; password: string }> = {},
    builderOverride?: BrowserCapabilityBuilder,
    secretProviderOverride?: LocalSecretProvider,
  ) {
    this.sdk = new ExperimentalBrowserCapabilitySdk({
      driver: new ExperimentalBrowserDriver(
        { [TARGET_ALIAS]: target(world) },
        new PlaywrightBrowserSessionFactory(),
      ),
      registry: new FileBrowserCapabilityRegistry(path.join(dataDirectory, "browser-registry")),
      trustedSource: new StaticTrustedBrowserCapabilitySource("empty-gitea-browser-catalog", []),
      builder: builderOverride ?? new TrustedUiContractBrowserCapabilityBuilder(
          "trusted-gitea-ui-contract-builder-v1",
          [REAL_GITEA_BROWSER_UI_CONTRACT],
        ),
      outcomeVerifier: (request) => this.outcomeVerifier(request),
      secretProvider: secretProviderOverride ?? secrets(world, credentialOverride),
    });
  }

  request(suffix: string): BrowserCapabilityGoalRequest {
    const marker = `[CF-BROWSER:${suffix}]`;
    return {
      tenantId: "real-gitea-browser-tenant",
      requestId: `real-gitea-browser-request-${suffix}`,
      parentGoalId: `real-gitea-browser-parent-${suffix}`,
      ordinaryGoal: `Create and verify one fictional Gitea incident for ${suffix}.`,
      needKey: REAL_GITEA_BROWSER_UI_CONTRACT.needKey,
      uiContractHash: REAL_GITEA_BROWSER_UI_CONTRACT.contractHash,
      operationKey: `real-gitea-browser-operation-${suffix}`,
      input: {
        title: `[${suffix}] Browser-backed incident`,
        body: `${marker}\n\nSynthetic incident created through the genuine disposable Gitea UI.`,
      },
      approvals: [REAL_GITEA_BROWSER_UI_CONTRACT.workPage.approvalKey],
    };
  }

  complete(request: BrowserCapabilityGoalRequest) {
    return this.sdk.completeGoal(request);
  }

  modeRunner(): CapabilityModeRunner {
    return createBrowserModeRunner(this.sdk);
  }

  target(): ExperimentalBrowserTarget {
    return target(this.world);
  }

  private outcomeVerifier(request: BrowserCapabilityGoalRequest): ExperimentalBrowserOutcomeVerifier {
    const marker = request.input.body?.match(/^\[CF-BROWSER:[^\]]+\]/)?.[0];
    if (!marker) throw new Error("Gitea browser request body requires a unique verification marker.");
    return {
      key: REAL_GITEA_BROWSER_UI_CONTRACT.outcomeVerifierKey,
      verify: async (operationKey) => {
        if (operationKey !== request.operationKey) {
          return { outcome: "unknown", detail: "The Gitea verifier received the wrong operation identity." };
        }
        const issues = await this.world.listIssuesDirect();
        const matching = issues.filter((issue) => issue.body.includes(marker));
        if (matching.length === 0) {
          return { outcome: "not-started", detail: "No Gitea issue contains the unique browser operation marker.", stateDigest: await this.world.stateHash() };
        }
        const direct = await this.world.verifyBrowserIssue({
          marker,
          title: request.input.title!,
          body: request.input.body!,
        });
        if (direct.passed) {
          return { outcome: "complete", detail: direct.detail, stateDigest: direct.stateHash };
        }
        return {
          outcome: direct.incorrectSideEffects > 0 ? "incorrect" : "partial",
          detail: direct.detail,
          stateDigest: direct.stateHash,
        };
      },
    };
  }
}
