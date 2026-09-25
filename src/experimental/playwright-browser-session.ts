import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import type {
  BrowserControlKind,
  ExperimentalBrowserLocator,
  ExperimentalBrowserSession,
  ExperimentalBrowserSessionFactory,
  ExperimentalBrowserTarget,
} from "./browser-driver.js";
import { browserRequestPathMatches, ExperimentalBrowserPolicyViolationError } from "./browser-driver.js";

export interface PlaywrightBrowserSessionFactoryOptions {
  headless?: boolean;
  executablePath?: string;
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
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
  if (url.origin !== targetOrigin(target)) return undefined;
  if (url.hash) return undefined;
  return target.allowedRequests.find((candidate) =>
    browserRequestPathMatches(url.pathname, candidate.path)
      && candidate.method === method
      && url.search === (candidate.query ?? ""),
  );
}

class PlaywrightBrowserSession implements ExperimentalBrowserSession {
  private violation: Error | null = null;
  private activeRequestPurpose: "read" | "session-auth" | "business-write" | null = null;

  constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly target: ExperimentalBrowserTarget,
    private readonly mode: "verify" | "execute",
  ) {}

  async installGuards(): Promise<void> {
    await this.context.route("**/*", async (route: Route) => {
      const request = route.request();
      if (this.target.blockedResourceTypes?.includes(request.resourceType() as "stylesheet" | "image" | "font" | "media" | "script")) {
        await route.abort("blockedbyclient");
        return;
      }
      const policy = requestPolicy(this.target, request.url(), request.method());
      const purposeMismatch = policy && policy.purpose !== "read" && policy.purpose !== this.activeRequestPurpose;
      if (!policy || purposeMismatch || (this.mode === "verify" && policy.purpose === "business-write")) {
        this.violation ??= new ExperimentalBrowserPolicyViolationError(`Browser request escaped the allowlist: ${route.request().url()}`);
        await route.abort("blockedbyclient");
        return;
      }
      const key = `${request.method()} ${policy.path}${policy.query ?? ""}`;
      const next = (this.requestCounts.get(key) ?? 0) + 1;
      this.requestCounts.set(key, next);
      if (next > policy.maxPerSession) {
        this.violation ??= new ExperimentalBrowserPolicyViolationError(`Browser request exceeded its session limit: ${key}`);
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await this.context.routeWebSocket("**/*", (socket) => {
      this.violation ??= new ExperimentalBrowserPolicyViolationError("Browser capability attempted to open a WebSocket.");
      socket.close();
    });
    this.context.on("page", (candidate) => {
      if (candidate === this.page) return;
      this.violation ??= new ExperimentalBrowserPolicyViolationError("Browser capability attempted to open a new page or popup.");
      void candidate.close().catch(() => undefined);
    });
    this.page.on("download", (download) => {
      this.violation ??= new ExperimentalBrowserPolicyViolationError("Browser capability attempted a download.");
      void download.cancel().catch(() => undefined);
    });
    this.page.on("filechooser", (chooser) => {
      this.violation ??= new ExperimentalBrowserPolicyViolationError("Browser capability attempted a file chooser.");
      void chooser.setFiles([]).catch(() => undefined);
    });
    this.page.on("dialog", (dialog) => {
      this.violation ??= new ExperimentalBrowserPolicyViolationError(`Browser capability opened an unexpected ${dialog.type()} dialog.`);
      void dialog.dismiss().catch(() => undefined);
    });
  }

  async navigate(rawUrl: string): Promise<void> {
    const url = new URL(rawUrl);
    if (url.origin !== targetOrigin(this.target) || !this.target.allowedNavigationPaths.includes(url.pathname)) {
      throw new ExperimentalBrowserPolicyViolationError(`Browser navigation escaped the allowlist: ${url.toString()}`);
    }
    await this.page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await this.assertNoViolation();
    const final = new URL(this.page.url());
    if (final.origin !== targetOrigin(this.target) || !this.target.allowedNavigationPaths.includes(final.pathname)) {
      throw new ExperimentalBrowserPolicyViolationError(`Browser navigation redirected outside the allowlist: ${final.toString()}`);
    }
  }

  async inspect(testId: ExperimentalBrowserLocator, kind: BrowserControlKind): Promise<void> {
    const locator = this.locator(testId);
    const count = await locator.count();
    const description = JSON.stringify(testId);
    if (count !== 1) throw new Error(`Expected exactly one browser control ${description}; found ${count}.`);
    if (!(await locator.isVisible())) throw new Error(`Browser control is not visible: ${description}`);
    if (kind === "fill" && !(await locator.isEditable())) throw new Error(`Browser control is not editable: ${description}`);
    if (kind === "click" && !(await locator.isEnabled())) throw new Error(`Browser control is not enabled: ${description}`);
    await this.assertNoViolation();
  }

  async readText(testId: ExperimentalBrowserLocator): Promise<string> {
    await this.inspect(testId, "read");
    const value = normalizedText(await this.locator(testId).innerText());
    if (value.length > 1_000) throw new Error(`Browser output exceeded the bounded text limit: ${JSON.stringify(testId)}`);
    return value;
  }

  async fill(testId: ExperimentalBrowserLocator, value: string): Promise<void> {
    if (value.length > 16_384) throw new Error(`Browser input exceeded the bounded value limit: ${JSON.stringify(testId)}`);
    await this.inspect(testId, "fill");
    await this.locator(testId).fill(value);
    await this.assertNoViolation();
  }

  async click(
    testId: ExperimentalBrowserLocator,
    purpose: "read" | "session-auth" | "business-write",
  ): Promise<void> {
    await this.inspect(testId, "click");
    this.activeRequestPurpose = purpose;
    try {
      await this.locator(testId).click();
      await this.page.waitForTimeout(75);
      await this.assertNoViolation();
    } finally {
      this.activeRequestPurpose = null;
    }
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined);
    await this.browser.close().catch(() => undefined);
  }

  private async assertNoViolation(): Promise<void> {
    await Promise.resolve();
    if (this.violation) throw this.violation;
  }

  private locator(locator: ExperimentalBrowserLocator) {
    if (locator.kind === "test-id") return this.page.getByTestId(locator.value);
    if (locator.kind === "label") return this.page.getByLabel(locator.value, { exact: locator.exact });
    if (locator.kind === "placeholder") return this.page.getByPlaceholder(locator.value, { exact: locator.exact });
    return locator.name
      ? this.page.getByRole(locator.role, { name: locator.name, exact: true })
      : this.page.getByRole(locator.role);
  }

  private readonly requestCounts = new Map<string, number>();
}

/** Real customer-local Chromium adapter for the isolated browser driver. */
export class PlaywrightBrowserSessionFactory implements ExperimentalBrowserSessionFactory {
  constructor(private readonly options: PlaywrightBrowserSessionFactoryOptions = {}) {}

  async open(target: ExperimentalBrowserTarget, mode: "verify" | "execute"): Promise<ExperimentalBrowserSession> {
    const browser = await chromium.launch({
      headless: this.options.headless ?? true,
      ...(this.options.executablePath ? { executablePath: this.options.executablePath } : {}),
    });
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
    const session = new PlaywrightBrowserSession(browser, context, page, target, mode);
    await session.installGuards();
    return session;
  }
}
