import { createHash, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

export const PILOT_RELEASE_SCHEMA_VERSION = "1.0" as const;

const relativePath = z.string().min(1).max(500).refine((value) =>
  !path.isAbsolute(value) && !value.split(/[\\/]/).includes(".."),
  "Release paths must be relative and cannot traverse directories.",
);

export const pilotReleaseManifestSchema = z.object({
  schemaVersion: z.literal(PILOT_RELEASE_SCHEMA_VERSION),
  product: z.literal("capability-factory-customer-local-pilot"),
  productVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdAt: z.string().datetime(),
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  files: z.array(z.object({
    path: relativePath,
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).min(1).max(10_000),
}).strict();

export type PilotReleaseManifest = z.infer<typeof pilotReleaseManifestSchema>;

const forbiddenSegments = new Set([".git", "node_modules", "output", "private", "tmp", "secrets"]);
const reviewedSecretHandlingSourceFiles = new Set(["src/product/secrets.ts"]);

function regularFilesBelow(rootDirectory: string, relativeDirectory: string): string[] {
  const root = path.resolve(rootDirectory);
  const start = path.resolve(root, relativeDirectory);
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release input tree refuses symbolic links: ${path.relative(root, filename)}`);
      if (entry.isDirectory()) walk(filename);
      else if (entry.isFile()) found.push(path.relative(root, filename).split(path.sep).join("/"));
      else throw new Error(`Release input tree supports regular files only: ${path.relative(root, filename)}`);
    }
  };
  walk(start);
  return found.sort();
}

/** Exact tracked inputs admitted by the pilot container's allowlisted build/release shape. */
export function listPilotContainerReleaseInputs(rootDirectory: string): string[] {
  const fixed = [
    ".dockerignore",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "tsconfig.pilot-container.json",
    "packaging/pilot/Dockerfile",
    "packaging/pilot/compose.example.yml",
    "packaging/pilot/compose.release.example.yml",
  ];
  for (const relative of fixed) safeFile(rootDirectory, relative);
  return [...fixed, ...regularFilesBelow(rootDirectory, "src")].sort();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSafeRelativePath(relative: string): void {
  const parts = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || parts.includes("..") || parts.some((part) => forbiddenSegments.has(part))) {
    throw new Error(`Unsafe release input path: ${relative}`);
  }
  const basename = path.basename(relative).toLowerCase();
  const normalized = parts.join("/");
  if (basename.startsWith(".env") || (/(?:credential|secret|token|private[-_.]?key)/i.test(basename) && !reviewedSecretHandlingSourceFiles.has(normalized))) {
    throw new Error(`Secret-shaped files cannot enter a release manifest: ${relative}`);
  }
}

function safeFile(rootDirectory: string, relative: string): string {
  assertSafeRelativePath(relative);
  const root = path.resolve(rootDirectory);
  const filename = path.resolve(root, relative);
  if (filename === root || !filename.startsWith(`${root}${path.sep}`)) throw new Error(`Release input escaped its root: ${relative}`);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input must be a regular non-symlink file: ${relative}`);
  if (stat.size <= 0 || stat.size > 50_000_000) throw new Error(`Release input must contain 1 to 50,000,000 bytes: ${relative}`);
  return filename;
}

function writeExclusive(filename: string, contents: string, mode: number): void {
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filename, contents, { encoding: "utf8", flag: "wx", mode });
}

export function releaseManifestBytes(manifest: PilotReleaseManifest): Buffer {
  return Buffer.from(canonical(pilotReleaseManifestSchema.parse(manifest)), "utf8");
}

export function createPilotReleaseManifest(input: {
  rootDirectory: string;
  productVersion: string;
  files: readonly string[];
  createdAt?: string;
  imageDigest?: string;
}): PilotReleaseManifest {
  const unique = [...new Set(input.files)].sort();
  if (unique.length !== input.files.length) throw new Error("Release inputs must be unique.");
  const files = unique.map((relative) => {
    const filename = safeFile(input.rootDirectory, relative);
    const value = fs.readFileSync(filename);
    return { path: relative, bytes: value.byteLength, sha256: digest(value) };
  });
  return pilotReleaseManifestSchema.parse({
    schemaVersion: PILOT_RELEASE_SCHEMA_VERSION,
    product: "capability-factory-customer-local-pilot",
    productVersion: input.productVersion,
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(input.imageDigest ? { imageDigest: input.imageDigest } : {}),
    files,
  });
}

export function writePilotReleaseManifest(filename: string, manifest: PilotReleaseManifest): void {
  writeExclusive(filename, `${JSON.stringify(pilotReleaseManifestSchema.parse(manifest), null, 2)}\n`, 0o600);
}

export function readPilotReleaseManifest(filename: string): PilotReleaseManifest {
  return pilotReleaseManifestSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
}

export function verifyPilotReleaseFiles(rootDirectory: string, manifest: PilotReleaseManifest): {
  valid: boolean;
  checks: Array<{ path: string; passed: boolean; detail: string }>;
} {
  const parsed = pilotReleaseManifestSchema.parse(manifest);
  const checks = parsed.files.map((record) => {
    try {
      const filename = safeFile(rootDirectory, record.path);
      const value = fs.readFileSync(filename);
      const passed = value.byteLength === record.bytes && digest(value) === record.sha256;
      return { path: record.path, passed, detail: passed ? "Bytes and SHA-256 match." : "Bytes or SHA-256 differ." };
    } catch (error) {
      return { path: record.path, passed: false, detail: error instanceof Error ? error.message : String(error) };
    }
  });
  return { valid: checks.every((check) => check.passed), checks };
}

export function generatePilotReleaseKeyPair(privateKeyPath: string, publicKeyPath: string): void {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  writeExclusive(privateKeyPath, pair.privateKey, 0o600);
  try {
    writeExclusive(publicKeyPath, pair.publicKey, 0o644);
  } catch (error) {
    fs.rmSync(privateKeyPath, { force: true });
    throw error;
  }
}

export function signPilotReleaseManifest(manifest: PilotReleaseManifest, privateKeyPath: string, signaturePath: string): void {
  const privateKey = fs.readFileSync(privateKeyPath, "utf8");
  const signature = sign(null, releaseManifestBytes(manifest), privateKey).toString("base64");
  writeExclusive(signaturePath, `${signature}\n`, 0o600);
}

export function verifyPilotReleaseSignature(manifest: PilotReleaseManifest, publicKeyPath: string, signaturePath: string): boolean {
  const publicKey = fs.readFileSync(publicKeyPath, "utf8");
  const encoded = fs.readFileSync(signaturePath, "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  return verify(null, releaseManifestBytes(manifest), publicKey, Buffer.from(encoded, "base64"));
}

export function writePilotReleaseReceipt(filename: string, value: unknown): void {
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}
