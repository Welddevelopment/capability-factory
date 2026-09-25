import path from "node:path";
import {
  createPilotReleaseManifest,
  generatePilotReleaseKeyPair,
  readPilotReleaseManifest,
  signPilotReleaseManifest,
  verifyPilotReleaseFiles,
  verifyPilotReleaseSignature,
  writePilotReleaseManifest,
  listPilotContainerReleaseInputs,
} from "./pilot-release.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
function required(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`Missing required option ${name}`);
  return value;
}
function usage(): never {
  throw new Error([
    "Usage:",
    "  pnpm pilot:release manifest --root <repo> --version <semver> --output <manifest.json> (--container-context | --files <comma-separated>) [--image-digest sha256:...]",
    "  pnpm pilot:release keygen --private <private.pem> --public <public.pem>",
    "  pnpm pilot:release sign --manifest <manifest.json> --private <private.pem> --signature <manifest.sig>",
    "  pnpm pilot:release verify --root <repo> --manifest <manifest.json> [--public <public.pem> --signature <manifest.sig>]",
  ].join("\n"));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "manifest") {
    const rootDirectory = path.resolve(required("--root"));
    const containerContext = process.argv.includes("--container-context");
    const explicitFiles = option("--files")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
    if (containerContext === (explicitFiles.length > 0)) throw new Error("Choose exactly one of --container-context or --files.");
    const files = containerContext ? listPilotContainerReleaseInputs(rootDirectory) : explicitFiles;
    const manifest = createPilotReleaseManifest({
      rootDirectory,
      productVersion: required("--version"),
      files,
      ...(option("--image-digest") ? { imageDigest: option("--image-digest")! } : {}),
    });
    const output = path.resolve(required("--output"));
    writePilotReleaseManifest(output, manifest);
    process.stdout.write(`${JSON.stringify({ status: "manifest-created", output, files: manifest.files.length }, null, 2)}\n`);
    return;
  }
  if (command === "keygen") {
    const privateKey = path.resolve(required("--private"));
    const publicKey = path.resolve(required("--public"));
    generatePilotReleaseKeyPair(privateKey, publicKey);
    process.stdout.write(`${JSON.stringify({ status: "key-pair-created", privateKey, publicKey, warning: "Keep the private key outside the repository and customer bundle." }, null, 2)}\n`);
    return;
  }
  if (command === "sign") {
    const manifestPath = path.resolve(required("--manifest"));
    const signature = path.resolve(required("--signature"));
    signPilotReleaseManifest(readPilotReleaseManifest(manifestPath), path.resolve(required("--private")), signature);
    process.stdout.write(`${JSON.stringify({ status: "manifest-signed", manifest: manifestPath, signature }, null, 2)}\n`);
    return;
  }
  if (command === "verify") {
    const root = path.resolve(required("--root"));
    const manifestPath = path.resolve(required("--manifest"));
    const manifest = readPilotReleaseManifest(manifestPath);
    const files = verifyPilotReleaseFiles(root, manifest);
    const publicKey = option("--public");
    const signature = option("--signature");
    if (Boolean(publicKey) !== Boolean(signature)) throw new Error("Signature verification requires both --public and --signature.");
    const signatureValid = publicKey && signature
      ? verifyPilotReleaseSignature(manifest, path.resolve(publicKey), path.resolve(signature))
      : undefined;
    const valid = files.valid && signatureValid !== false;
    process.stdout.write(`${JSON.stringify({ status: valid ? "verified" : "failed", files, ...(signatureValid === undefined ? {} : { signatureValid }) }, null, 2)}\n`);
    if (!valid) process.exitCode = 1;
    return;
  }
  usage();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
