import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(kitRoot, "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(kitRoot, "FROZEN_MANIFEST.json"), "utf8"));

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

const failures = [];
for (const [relativePath, expected] of Object.entries(manifest.bundleDigests)) {
  const filePath = path.join(kitRoot, relativePath);
  if (!fs.existsSync(filePath)) failures.push(`${relativePath}: missing`);
  else if (sha256(filePath) !== expected) failures.push(`${relativePath}: digest mismatch`);
}
for (const [relativePath, expected] of Object.entries(manifest.productBaseline.sourceDigests)) {
  const filePath = path.join(repositoryRoot, relativePath);
  if (!fs.existsSync(filePath)) failures.push(`${relativePath}: missing`);
  else if (sha256(filePath) !== expected) failures.push(`${relativePath}: product digest mismatch`);
}

if (failures.length > 0) {
  process.stderr.write(`Validation kit verification failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Validation kit verified: ${Object.keys(manifest.bundleDigests).length} bundle files and ${Object.keys(manifest.productBaseline.sourceDigests).length} product inputs.\n`);
}
