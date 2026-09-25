import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPilotReleaseManifest,
  generatePilotReleaseKeyPair,
  signPilotReleaseManifest,
  verifyPilotReleaseFiles,
  verifyPilotReleaseSignature,
  listPilotContainerReleaseInputs,
} from "../src/product/pilot-release.js";

const roots: string[] = [];
function fixture(): string { const root = fs.mkdtempSync(path.join(os.tmpdir(), "cf-release-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("pilot release integrity", () => {
  it("pins explicit safe inputs and detects later changes", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    const manifest = createPilotReleaseManifest({ rootDirectory: root, productVersion: "0.1.0", files: ["package.json"], createdAt: "2026-07-29T00:00:00.000Z" });
    expect(verifyPilotReleaseFiles(root, manifest).valid).toBe(true);
    fs.appendFileSync(path.join(root, "package.json"), "tampered\n");
    expect(verifyPilotReleaseFiles(root, manifest).valid).toBe(false);
  });

  it("signs canonical manifests and rejects changed manifests", () => {
    const root = fixture(); fs.writeFileSync(path.join(root, "package.json"), "{}\n");
    const manifest = createPilotReleaseManifest({ rootDirectory: root, productVersion: "0.1.0", files: ["package.json"], createdAt: "2026-07-29T00:00:00.000Z" });
    const privateKey = path.join(root, "outside-private.pem"); const publicKey = path.join(root, "outside-public.pem"); const signature = path.join(root, "release.sig");
    generatePilotReleaseKeyPair(privateKey, publicKey); signPilotReleaseManifest(manifest, privateKey, signature);
    expect(fs.statSync(privateKey).mode & 0o077).toBe(0);
    expect(verifyPilotReleaseSignature(manifest, publicKey, signature)).toBe(true);
    expect(verifyPilotReleaseSignature({ ...manifest, productVersion: "0.1.1" }, publicKey, signature)).toBe(false);
  });

  it("rejects private and secret-shaped release inputs", () => {
    const root = fixture(); fs.mkdirSync(path.join(root, "private")); fs.writeFileSync(path.join(root, "private", "data.json"), "{}\n");
    fs.writeFileSync(path.join(root, ".env.local"), "KEY=value\n");
    expect(() => createPilotReleaseManifest({ rootDirectory: root, productVersion: "0.1.0", files: ["private/data.json"] })).toThrow(/unsafe/i);
    expect(() => createPilotReleaseManifest({ rootDirectory: root, productVersion: "0.1.0", files: [".env.local"] })).toThrow(/secret-shaped/i);
    fs.mkdirSync(path.join(root, "src", "product"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "product", "secrets.ts"), "export class CustomerLocalSecretProvider {}\n");
    expect(createPilotReleaseManifest({ rootDirectory: root, productVersion: "0.1.0", files: ["src/product/secrets.ts"] }).files).toHaveLength(1);
  });

  it("enumerates the complete allowlisted container context and refuses symlinks", () => {
    const root = fixture();
    for (const filename of [".dockerignore", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "tsconfig.pilot-container.json", "packaging/pilot/Dockerfile", "packaging/pilot/compose.example.yml", "packaging/pilot/compose.release.example.yml"]) {
      fs.mkdirSync(path.dirname(path.join(root, filename)), { recursive: true });
      fs.writeFileSync(path.join(root, filename), `${filename}\n`);
    }
    fs.mkdirSync(path.join(root, "src", "nested"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "entry.ts"), "export {};\n");
    fs.writeFileSync(path.join(root, "src", "nested", "dependency.ts"), "export {};\n");
    expect(listPilotContainerReleaseInputs(root)).toEqual(expect.arrayContaining([".dockerignore", "src/entry.ts", "src/nested/dependency.ts"]));
    fs.symlinkSync(path.join(root, "src", "entry.ts"), path.join(root, "src", "linked.ts"));
    expect(() => listPilotContainerReleaseInputs(root)).toThrow(/symbolic links/);
  });
});
