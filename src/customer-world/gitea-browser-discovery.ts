import type { BrowserDiscoveryBoundary } from "../experimental/browser-discovery.js";

export const GITEA_DISCOVERY_USERNAME_ALIAS = "gitea_browser_username";
export const GITEA_DISCOVERY_PASSWORD_ALIAS = "gitea_browser_password";

function exactLabel(value: string) {
  return { kind: "label" as const, value, exact: true as const };
}

function exactRole(role: "button" | "heading", name: string) {
  return { kind: "role" as const, role, name, exact: true as const };
}

/** Replaceable trusted boundary for the genuine disposable Gitea transfer world. */
export function giteaBrowserDiscoveryBoundary(): BrowserDiscoveryBoundary {
  return {
    schemaVersion: "1.0",
    boundaryId: "gitea-issue-discovery-v1",
    capabilityIdPrefix: "discovered-gitea-issue",
    needKey: "create-gitea-issue-through-ui",
    targetAlias: "gitea_browser",
    outcomeVerifierKey: "gitea-independent-admin-api-browser-v1",
    seedPaths: ["/cf-admin/cf-incident-intake/issues/new"],
    allowedPaths: ["/user/login", "/cf-admin/cf-incident-intake/issues/new"],
    inputs: [
      { key: "title", description: "Issue title describing the synthetic incident." },
      { key: "body", description: "Issue body with the incident details; leave it as the issue comment body." },
    ],
    secretAliases: [GITEA_DISCOVERY_USERNAME_ALIAS, GITEA_DISCOVERY_PASSWORD_ALIAS],
    writeApprovalKey: "create-gitea-issue",
    maxBusinessWrites: 1,
    completion: {
      kind: "input-contains",
      description: "Main issue page containing the newly created issue title.",
      inputKey: "title",
    },
    authentication: {
      kind: "trusted-session-form",
      path: "/user/login",
      assertions: [{ locator: exactRole("heading", "Sign In"), expectedText: "Sign In" }],
      fields: [
        { locator: exactLabel("Username or Email Address"), secretAlias: GITEA_DISCOVERY_USERNAME_ALIAS },
        { locator: exactLabel("Password"), secretAlias: GITEA_DISCOVERY_PASSWORD_ALIAS },
      ],
      submit: exactRole("button", "Sign In"),
      secretAliases: [GITEA_DISCOVERY_USERNAME_ALIAS, GITEA_DISCOVERY_PASSWORD_ALIAS],
      humanGatePolicy: "stop-and-handoff",
    },
  };
}
