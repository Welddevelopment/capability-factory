import { chromium, type BrowserContext, type Page, type Route } from "playwright";
import type { LocalSecretProvider } from "../product/secrets.js";
import {
  browserRequestPathMatches,
  ExperimentalBrowserPolicyViolationError,
  type ExperimentalBrowserLocator,
  type ExperimentalBrowserTarget,
} from "./browser-driver.js";
import {
  browserDiscoveryBoundaryHash,
  browserDiscoveryBoundarySchema,
  defineBrowserDiscoverySnapshot,
  discoveredBrowserControlSchema,
  discoveredControlId,
  type BrowserDiscoveryBoundary,
  type BrowserDiscoveryPage,
  type BrowserUiDiscoverer,
  type DiscoveredBrowserControl,
} from "./browser-discovery.js";

export interface PlaywrightBrowserDiscovererOptions {
  headless?: boolean;
  executablePath?: string;
  secretProvider?: LocalSecretProvider;
}

export class BrowserDiscoveryAuthenticationError extends Error {
  readonly code = "browser-discovery-authentication-required";

  constructor(
    readonly reason: "credential-rejected" | "session-expired",
    message: string,
  ) {
    super(message);
    this.name = "BrowserDiscoveryAuthenticationError";
  }
}

interface RawControl {
  tag: string;
  role: string | null;
  testId: string | null;
  label: string | null;
  placeholder: string | null;
  accessibleName: string;
  inputType: string | null;
  href: string | null;
  ariaLive: string | null;
  disabled: boolean;
  readOnly: boolean;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

function targetOrigin(target: ExperimentalBrowserTarget): string {
  return new URL(target.origin).origin;
}

function requestPolicy(target: ExperimentalBrowserTarget, rawUrl: string, method: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }
  if (url.origin !== targetOrigin(target) || url.hash) return undefined;
  return target.allowedRequests.find((candidate) =>
    browserRequestPathMatches(url.pathname, candidate.path)
      && candidate.method === method
      && url.search === (candidate.query ?? ""),
  );
}

function locator(page: Page, target: ExperimentalBrowserLocator) {
  if (target.kind === "test-id") return page.getByTestId(target.value);
  if (target.kind === "label") return page.getByLabel(target.value, { exact: target.exact });
  if (target.kind === "placeholder") return page.getByPlaceholder(target.value, { exact: target.exact });
  return target.name
    ? page.getByRole(target.role, { name: target.name, exact: true })
    : page.getByRole(target.role);
}

function semanticRole(raw: RawControl): "button" | "link" | "textbox" | "checkbox" | "heading" | "status" | "main" | undefined {
  if (["button", "link", "textbox", "checkbox", "heading", "status", "main"].includes(raw.role ?? "")) {
    return raw.role as "button" | "link" | "textbox" | "checkbox" | "heading" | "status" | "main";
  }
  if (raw.tag === "button") return "button";
  if (raw.tag === "a") return "link";
  if (raw.tag === "textarea" || raw.tag === "select") return "textbox";
  if (raw.tag === "input") return raw.inputType === "checkbox" ? "checkbox" : "textbox";
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(raw.tag)) return "heading";
  if (raw.tag === "main") return "main";
  if (raw.ariaLive) return "status";
  return undefined;
}

function locatorCandidates(raw: RawControl): ExperimentalBrowserLocator[] {
  const candidates: ExperimentalBrowserLocator[] = [];
  if (raw.testId && /^[a-zA-Z0-9_-]{1,160}$/.test(raw.testId)) {
    candidates.push({ kind: "test-id", value: raw.testId });
  }
  if (raw.label && raw.label.length <= 200) {
    candidates.push({ kind: "label", value: raw.label, exact: true });
  }
  if (raw.placeholder && raw.placeholder.length <= 200) {
    candidates.push({ kind: "placeholder", value: raw.placeholder, exact: true });
  }
  const role = semanticRole(raw);
  if (role === "main") {
    candidates.push({ kind: "role", role: "main" });
  }
  if (role && raw.accessibleName && raw.accessibleName.length <= 200) {
    if (role !== "main") candidates.push({ kind: "role", role, name: raw.accessibleName, exact: true });
  }
  return candidates;
}

function elementKind(raw: RawControl): DiscoveredBrowserControl["element"] {
  if (raw.tag === "a") return "link";
  if (["input", "textarea", "select", "button"].includes(raw.tag)) return raw.tag as "input" | "textarea" | "select" | "button";
  if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(raw.tag)) return "heading";
  if (semanticRole(raw) === "status") return "status";
  return "other";
}

function humanGateSignal(
  raw: RawControl,
  boundary: BrowserDiscoveryBoundary,
): DiscoveredBrowserControl["humanGateSignal"] {
  const words = `${raw.accessibleName} ${raw.label ?? ""} ${raw.placeholder ?? ""}`.toLowerCase();
  if (/captcha|not a robot/.test(words)) return "captcha";
  if (/security key|passkey|hardware key/.test(words)) return "security-key";
  if (/verification code|one[- ]?time|\botp\b|two[- ]?factor|2fa|multi[- ]?factor/.test(words)) return "mfa";
  if (/single sign[- ]?on|\bsso\b|sign in with/.test(words)) return "sso";
  if (
    raw.inputType === "password"
    && boundary.authentication.kind === "none"
    && boundary.secretAliases.length === 0
  ) return "unknown-auth";
  return "none";
}

async function uniqueLocator(page: Page, raw: RawControl): Promise<ExperimentalBrowserLocator | undefined> {
  for (const candidate of locatorCandidates(raw)) {
    const selected = locator(page, candidate);
    if (await selected.count() === 1 && await selected.isVisible()) return candidate;
  }
  return undefined;
}

async function extractControls(
  page: Page,
  pagePath: string,
  boundary: BrowserDiscoveryBoundary,
): Promise<DiscoveredBrowserControl[]> {
  const rawControls = await page.locator("main, input, textarea, select, button, a[href], [role], [data-testid], h1, h2, h3, h4, h5, h6").evaluateAll((elements: any[]) =>
    elements.slice(0, 160).map((element: any) => {
      const labelText = Array.from(element.labels ?? [])
        .map((label: any) => String(label.innerText ?? label.textContent ?? ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const ariaLabel = String(element.getAttribute?.("aria-label") ?? "").trim();
      const text = String(element.innerText ?? element.textContent ?? "").replace(/\s+/g, " ").trim();
      const placeholder = String(element.getAttribute?.("placeholder") ?? "").trim();
      return {
        tag: String(element.tagName ?? "").toLowerCase(),
        role: element.getAttribute?.("role") ?? null,
        testId: element.getAttribute?.("data-testid") ?? null,
        label: labelText || null,
        placeholder: placeholder || null,
        accessibleName: (ariaLabel || labelText || placeholder || text).slice(0, 300),
        inputType: element.getAttribute?.("type") ?? null,
        href: element.getAttribute?.("href") ?? null,
        ariaLive: element.getAttribute?.("aria-live") ?? null,
        disabled: Boolean(element.disabled),
        readOnly: Boolean(element.readOnly),
      } satisfies RawControl;
    }),
  );
  const controls: DiscoveredBrowserControl[] = [];
  for (const raw of rawControls) {
    const semanticLocator = await uniqueLocator(page, raw);
    if (!semanticLocator) continue;
    let hrefPath: string | null = null;
    if (raw.href) {
      try {
        const href = new URL(raw.href, page.url());
        if (href.origin === new URL(page.url()).origin && boundary.allowedPaths.includes(href.pathname)) {
          hrefPath = href.pathname;
        }
      } catch {
        hrefPath = null;
      }
    }
    const element = elementKind(raw);
    controls.push(discoveredBrowserControlSchema.parse({
      controlId: discoveredControlId(pagePath, semanticLocator),
      pagePath,
      locator: semanticLocator,
      element,
      accessibleName: normalizedText(raw.accessibleName),
      inputType: raw.inputType?.slice(0, 80) ?? null,
      hrefPath,
      canRead: true,
      canFill: ["input", "textarea", "select"].includes(element) && !raw.disabled && !raw.readOnly,
      canClick: ["button", "link"].includes(element) && !raw.disabled,
      humanGateSignal: humanGateSignal(raw, boundary),
    }));
  }
  const unique = new Map(controls.map((control) => [control.controlId, control]));
  return [...unique.values()].slice(0, 120);
}

async function installDiscoveryGuards(
  context: BrowserContext,
  page: Page,
  target: ExperimentalBrowserTarget,
  activePurpose: { value: "session-auth" | null },
): Promise<() => void> {
  let violation: Error | null = null;
  const counts = new Map<string, number>();
  await context.route("**/*", async (route: Route) => {
    const request = route.request();
    if (target.blockedResourceTypes?.includes(request.resourceType() as "stylesheet" | "image" | "font" | "media" | "script")) {
      await route.abort("blockedbyclient");
      return;
    }
    const policy = requestPolicy(target, request.url(), request.method());
    const allowed = policy && (
      policy.purpose === "read"
      || (policy.purpose === "session-auth" && activePurpose.value === "session-auth")
    );
    if (!allowed || policy?.purpose === "business-write") {
      violation ??= new ExperimentalBrowserPolicyViolationError(`Read-only browser discovery blocked a request: ${request.method()} ${request.url()}`);
      await route.abort("blockedbyclient");
      return;
    }
    const key = `${request.method()} ${policy.path}${policy.query ?? ""}`;
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    if (next > policy.maxPerSession) {
      violation ??= new ExperimentalBrowserPolicyViolationError(`Browser discovery exceeded its request limit: ${key}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
  await context.routeWebSocket("**/*", (socket) => {
    violation ??= new ExperimentalBrowserPolicyViolationError("Browser discovery attempted to open a WebSocket.");
    socket.close();
  });
  context.on("page", (candidate) => {
    if (candidate === page) return;
    violation ??= new ExperimentalBrowserPolicyViolationError("Browser discovery attempted to open a popup.");
    void candidate.close().catch(() => undefined);
  });
  page.on("download", (download) => {
    violation ??= new ExperimentalBrowserPolicyViolationError("Browser discovery attempted a download.");
    void download.cancel().catch(() => undefined);
  });
  page.on("filechooser", (chooser) => {
    violation ??= new ExperimentalBrowserPolicyViolationError("Browser discovery attempted a file chooser.");
    void chooser.setFiles([]).catch(() => undefined);
  });
  page.on("dialog", (dialog) => {
    violation ??= new ExperimentalBrowserPolicyViolationError(`Browser discovery opened an unexpected ${dialog.type()} dialog.`);
    void dialog.dismiss().catch(() => undefined);
  });
  return () => {
    if (violation) throw violation;
  };
}

async function applyTrustedBootstrap(
  page: Page,
  target: ExperimentalBrowserTarget,
  boundary: BrowserDiscoveryBoundary,
  secretProvider: LocalSecretProvider,
  activePurpose: { value: "session-auth" | null },
  assertClean: () => void,
): Promise<void> {
  if (boundary.authentication.kind !== "trusted-session-form") {
    throw new Error("Trusted discovery session bootstrap requires a trusted-session-form boundary.");
  }
  const bootstrap = boundary.authentication;
  if (!target.allowedNavigationPaths.includes(bootstrap.path)) {
    throw new Error("Trusted discovery session bootstrap path is outside the installed target policy.");
  }
  await page.goto(new URL(bootstrap.path, target.origin).toString(), { waitUntil: "domcontentloaded" });
  assertClean();
  for (const assertion of bootstrap.assertions ?? []) {
    const actual = normalizedText(await locator(page, assertion.locator).innerText());
    if (actual !== normalizedText(assertion.expectedText)) throw new Error("Trusted discovery session bootstrap assertion failed.");
  }
  const resolved = new Map<string, string>();
  try {
    for (const field of bootstrap.fields) {
      if (!bootstrap.secretAliases.includes(field.secretAlias)) throw new Error("Trusted discovery bootstrap field used an undeclared secret alias.");
      const secret = await secretProvider.resolve({
        alias: field.secretAlias,
        targetAlias: boundary.targetAlias,
        actionName: "browser-discovery-session-auth",
        method: "BROWSER",
        runId: `browser-discovery-${Date.now()}`,
        testMode: true,
      });
      resolved.set(field.secretAlias, secret.value);
      await locator(page, field.locator).fill(secret.value);
    }
    activePurpose.value = "session-auth";
    await locator(page, bootstrap.submit).click();
    await page.waitForLoadState("domcontentloaded");
    assertClean();
    const afterAuthentication = new URL(page.url());
    if (afterAuthentication.pathname === bootstrap.path) {
      throw new BrowserDiscoveryAuthenticationError(
        "credential-rejected",
        "Trusted browser session authentication did not leave the approved login page. Credentials may be invalid or additional human authentication may be required.",
      );
    }
  } finally {
    activePurpose.value = null;
    resolved.clear();
  }
}

/** Trusted local scanner. It observes controls; it does not let a model drive the page. */
export class PlaywrightBrowserDiscoverer implements BrowserUiDiscoverer {
  constructor(private readonly options: PlaywrightBrowserDiscovererOptions = {}) {}

  async discover(
    target: ExperimentalBrowserTarget,
    rawBoundary: BrowserDiscoveryBoundary,
  ) {
    const boundary = browserDiscoveryBoundarySchema.parse(rawBoundary);
    const origin = new URL(target.origin);
    if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(origin.hostname)) {
      throw new Error("Experimental browser discovery is restricted to disposable localhost origins.");
    }
    if (boundary.targetAlias.length === 0 || boundary.allowedPaths.some((path) => !target.allowedNavigationPaths.includes(path))) {
      throw new Error("Browser discovery boundary is wider than the installed target navigation policy.");
    }
    if (boundary.authentication.kind === "trusted-session-form" && !this.options.secretProvider) {
      throw new Error("Browser discovery requires a trusted session bootstrap but none was configured.");
    }
    const browser = await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
    });
    const pages: BrowserDiscoveryPage[] = [];
    try {
      for (const requestedPath of boundary.seedPaths) {
        const context = await browser.newContext({
          acceptDownloads: false,
          serviceWorkers: "block",
          permissions: [],
          javaScriptEnabled: true,
          locale: "en-GB",
          timezoneId: "UTC",
          viewport: { width: 1280, height: 800 },
        });
        context.setDefaultTimeout(target.timeoutMs ?? 3_000);
        context.setDefaultNavigationTimeout(target.timeoutMs ?? 3_000);
        const page = await context.newPage();
        const activePurpose: { value: "session-auth" | null } = { value: null };
        const assertClean = await installDiscoveryGuards(context, page, target, activePurpose);
        try {
          if (boundary.authentication.kind === "trusted-session-form") {
            await applyTrustedBootstrap(page, target, boundary, this.options.secretProvider!, activePurpose, assertClean);
          }
          await page.goto(new URL(requestedPath, target.origin).toString(), { waitUntil: "domcontentloaded" });
          assertClean();
          const final = new URL(page.url());
          if (
            boundary.authentication.kind === "trusted-session-form"
            && final.pathname === boundary.authentication.path
            && requestedPath !== boundary.authentication.path
          ) {
            throw new BrowserDiscoveryAuthenticationError(
              "session-expired",
              `Trusted browser session could not reach ${requestedPath}; the target returned to its login page.`,
            );
          }
          if (final.origin !== origin.origin || !boundary.allowedPaths.includes(final.pathname)) {
            throw new ExperimentalBrowserPolicyViolationError(`Browser discovery redirected outside the approved boundary: ${final.toString()}`);
          }
          const controls = await extractControls(page, final.pathname, boundary);
          const headings = (await page.getByRole("heading").allTextContents())
            .map(normalizedText)
            .filter(Boolean)
            .slice(0, 20);
          pages.push({
            requestedPath,
            finalPath: final.pathname,
            title: normalizedText(await page.title()),
            headings,
            controls,
          });
        } finally {
          await context.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
    const humanGates = pages.flatMap((page) => page.controls
      .filter((control) => control.humanGateSignal !== "none")
      .map((control) => ({
        pagePath: page.finalPath,
        signal: control.humanGateSignal as Exclude<DiscoveredBrowserControl["humanGateSignal"], "none">,
        detail: `Discovery observed a ${control.humanGateSignal} control named ${control.accessibleName || "unnamed"}.`,
      })));
    return defineBrowserDiscoverySnapshot({
      schemaVersion: "1.0",
      boundaryId: boundary.boundaryId,
      boundaryHash: browserDiscoveryBoundaryHash(boundary),
      targetAlias: boundary.targetAlias,
      pages,
      humanGates,
    });
  }
}

export function targetWithDiscoveredLocators(
  target: ExperimentalBrowserTarget,
  snapshot: Awaited<ReturnType<PlaywrightBrowserDiscoverer["discover"]>>,
  boundary?: BrowserDiscoveryBoundary,
): ExperimentalBrowserTarget {
  const keys = new Set<string>();
  const allowedLocators: ExperimentalBrowserLocator[] = [];
  const authenticationLocators = boundary?.authentication.kind === "trusted-session-form"
    ? [
        ...boundary.authentication.assertions.map((assertion) => assertion.locator),
        ...boundary.authentication.fields.map((field) => field.locator),
        boundary.authentication.submit,
      ]
    : [];
  for (const item of [
    ...target.allowedLocators,
    ...authenticationLocators,
    ...snapshot.pages.flatMap((page) => page.controls.map((control) => control.locator)),
  ]) {
    const key = JSON.stringify(item);
    if (keys.has(key)) continue;
    keys.add(key);
    allowedLocators.push(item);
  }
  return { ...target, allowedLocators };
}
