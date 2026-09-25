import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

const ALIAS = /^[a-zA-Z0-9_-]{1,160}$/;

export interface SecretUseContext {
  alias: string;
  targetAlias: string;
  actionName: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "BROWSER";
  runId: string;
  testMode: boolean;
}

export interface ResolvedLocalSecret {
  value: string;
  /** Customer-local rotation label. It is safe to log; the value is not. */
  version: string;
}

export interface LocalSecretProvider {
  /** Checks alias availability without exposing or loading its value. */
  has(alias: string): boolean;
  /** Resolves a value only at the final customer-local execution boundary. */
  resolve(context: SecretUseContext): ResolvedLocalSecret | Promise<ResolvedLocalSecret>;
}

export interface SecretScope {
  targetAliases: string[];
  actionNames: string[];
  methods: SecretUseContext["method"][];
}

export interface ScopedSecretDescriptor {
  alias: string;
  version: string;
  scope: SecretScope;
}

function validateDescriptor(descriptor: ScopedSecretDescriptor): ScopedSecretDescriptor {
  if (!ALIAS.test(descriptor.alias)) throw new Error("Secret alias must be a bounded identifier.");
  if (!descriptor.version || descriptor.version.length > 160) throw new Error("Secret version must be a bounded label.");
  if (
    descriptor.scope.targetAliases.length === 0 ||
    descriptor.scope.actionNames.length === 0 ||
    descriptor.scope.methods.length === 0
  ) {
    throw new Error("A customer-local secret must have explicit target, action, and method scope.");
  }
  return structuredClone(descriptor);
}

function assertUseAllowed(descriptor: ScopedSecretDescriptor, context: SecretUseContext): void {
  if (
    !descriptor.scope.targetAliases.includes(context.targetAlias) ||
    !descriptor.scope.actionNames.includes(context.actionName) ||
    !descriptor.scope.methods.includes(context.method)
  ) {
    throw new Error(
      `Secret alias ${descriptor.alias} is not authorized for ${context.method} ${context.targetAlias}/${context.actionName}.`,
    );
  }
}

/** Test/reference provider that demonstrates rotation without changing manifests. */
export class RotatingMemorySecretProvider implements LocalSecretProvider {
  private readonly entries = new Map<string, { descriptor: ScopedSecretDescriptor; value: string }>();

  set(descriptor: ScopedSecretDescriptor, value: string): void {
    const safe = validateDescriptor(descriptor);
    if (!value) throw new Error("Secret value cannot be empty.");
    this.entries.set(safe.alias, { descriptor: safe, value });
  }

  delete(alias: string): void {
    this.entries.delete(alias);
  }

  has(alias: string): boolean {
    return this.entries.has(alias);
  }

  resolve(context: SecretUseContext): ResolvedLocalSecret {
    const entry = this.entries.get(context.alias);
    if (!entry) throw new Error(`Unknown customer-local secret alias: ${context.alias}`);
    assertUseAllowed(entry.descriptor, context);
    return { value: entry.value, version: entry.descriptor.version };
  }
}

/** Reads values from the customer process environment only at execution time. */
export class EnvironmentSecretProvider implements LocalSecretProvider {
  private readonly descriptors = new Map<string, ScopedSecretDescriptor & { environmentVariable: string }>();

  constructor(
    descriptors: Array<ScopedSecretDescriptor & { environmentVariable: string }>,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    for (const descriptor of descriptors) {
      const safe = validateDescriptor(descriptor);
      if (!/^[A-Z][A-Z0-9_]{0,159}$/.test(descriptor.environmentVariable)) {
        throw new Error("Secret environment variable must be an uppercase bounded identifier.");
      }
      if (this.descriptors.has(safe.alias)) throw new Error(`Duplicate secret alias: ${safe.alias}`);
      this.descriptors.set(safe.alias, { ...safe, environmentVariable: descriptor.environmentVariable });
    }
  }

  has(alias: string): boolean {
    const descriptor = this.descriptors.get(alias);
    return Boolean(descriptor && this.environment[descriptor.environmentVariable]);
  }

  resolve(context: SecretUseContext): ResolvedLocalSecret {
    const descriptor = this.descriptors.get(context.alias);
    if (!descriptor) throw new Error(`Unknown customer-local secret alias: ${context.alias}`);
    assertUseAllowed(descriptor, context);
    const value = this.environment[descriptor.environmentVariable];
    if (!value) throw new Error(`Customer-local secret alias is currently unavailable: ${context.alias}`);
    return { value, version: descriptor.version };
  }
}

/**
 * Reads one mode-0600 file per alias from a customer-owned directory. Symlinks,
 * broad file permissions, path traversal, empty values, and oversized values
 * are rejected.
 */
export class DirectorySecretProvider implements LocalSecretProvider {
  private readonly descriptors = new Map<string, ScopedSecretDescriptor>();
  private readonly root: string;

  constructor(rootDirectory: string, descriptors: ScopedSecretDescriptor[]) {
    this.root = path.resolve(rootDirectory);
    for (const descriptor of descriptors) {
      const safe = validateDescriptor(descriptor);
      if (this.descriptors.has(safe.alias)) throw new Error(`Duplicate secret alias: ${safe.alias}`);
      this.descriptors.set(safe.alias, safe);
    }
  }

  has(alias: string): boolean {
    if (!this.descriptors.has(alias)) return false;
    try {
      this.assertFile(alias);
      return true;
    } catch {
      return false;
    }
  }

  resolve(context: SecretUseContext): ResolvedLocalSecret {
    const descriptor = this.descriptors.get(context.alias);
    if (!descriptor) throw new Error(`Unknown customer-local secret alias: ${context.alias}`);
    assertUseAllowed(descriptor, context);
    const filename = this.assertFile(context.alias);
    const bytes = readFileSync(filename);
    if (bytes.byteLength === 0 || bytes.byteLength > 16_384) throw new Error("Customer-local secret file has an invalid size.");
    const value = bytes.toString("utf8").replace(/\r?\n$/, "");
    if (!value) throw new Error("Customer-local secret value cannot be empty.");
    return { value, version: descriptor.version };
  }

  private assertFile(alias: string): string {
    if (!ALIAS.test(alias)) throw new Error("Invalid customer-local secret alias.");
    const filename = path.resolve(this.root, alias);
    if (path.dirname(filename) !== this.root) throw new Error("Secret path escaped the customer-local directory.");
    const stat = lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Customer-local secret must be a regular non-symlink file.");
    if ((stat.mode & 0o077) !== 0) throw new Error("Customer-local secret file must not be readable by group or other users.");
    return filename;
  }
}
