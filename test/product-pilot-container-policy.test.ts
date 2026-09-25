import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("customer-local container policy", () => {
  it("keeps the host boundary local and the container least privileged", () => {
    const compose = fs.readFileSync("packaging/pilot/compose.example.yml", "utf8");
    expect(compose).toContain('"127.0.0.1:${CF_PORT:-4317}:4317"');
    expect(compose).toContain('CF_CONTAINER_LOCALHOST_PUBLISH: acknowledged');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).not.toMatch(/(?:\.env|secret|credential).*:\/app/i);
  });

  it("runs as a non-root user and excludes private inputs", () => {
    const dockerfile = fs.readFileSync("packaging/pilot/Dockerfile", "utf8");
    const compilerConfig = fs.readFileSync("tsconfig.pilot-container.json", "utf8");
    const ignore = fs.readFileSync(".dockerignore", "utf8");
    expect(dockerfile).toContain("USER 65532:65532");
    expect(dockerfile).toMatch(/FROM node:24-bookworm-slim@sha256:[a-f0-9]{64} AS build/);
    expect(dockerfile).toMatch(/FROM node:24-alpine@sha256:[a-f0-9]{64} AS node-runtime/);
    expect(dockerfile).toContain("FROM scratch AS runtime");
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/bin/node"');
    const runtimeStage = dockerfile.split("FROM scratch AS runtime")[1] ?? "";
    expect(runtimeStage).not.toMatch(/(?:apk|apt-get|npm|corepack)\s+(?:add|install)/);
    expect(dockerfile).toContain("pnpm-workspace.yaml");
    expect(dockerfile).not.toMatch(/COPY\s+\.\s+/);
    expect(compilerConfig).toContain('"files": ["src/product/run-pilot-package.ts"]');
    expect(compilerConfig).not.toContain('"src/**/*.ts"');
    expect(ignore.trimStart()).toMatch(/^\*/);
    expect(ignore).toContain("!src/**");
    expect(ignore).not.toContain("!private");
  });

  it("keeps the clean-room runtime explicitly zero-authority and fictional", () => {
    const runtime = fs.readFileSync("packaging/pilot/clean-room-runtime.mjs", "utf8");
    expect(runtime).toContain("Fictional installation-rehearsal runtime only");
    expect(runtime).toContain("scopes: { resolve: async () => undefined }");
    expect(runtime).not.toMatch(/(?:api[-_ ]?key|access[-_ ]?token|secret)\s*[:=]\s*["'][^"']{8,}/i);
  });

  it("provides a repository-independent release compose shape", () => {
    const compose = fs.readFileSync("packaging/pilot/compose.release.example.yml", "utf8");
    expect(compose).toContain("CF_IMAGE_REF");
    expect(compose).toContain("@sha256");
    expect(compose).not.toMatch(/^\s*build:/m);
    expect(compose.match(/<<: \*pilot-image/g)).toHaveLength(2);
    expect(compose).toContain('"127.0.0.1:${CF_PORT:-4317}:4317"');
    expect(compose).toContain('cap_drop: ["ALL"]');
    expect(compose).toContain('no-new-privileges:true');
  });
});
