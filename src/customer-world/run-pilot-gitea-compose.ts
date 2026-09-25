import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";

const command = process.argv[2];
if (command !== "up" && command !== "stop") {
  throw new Error("Usage: run-pilot-gitea-compose.ts <up|stop>");
}

const repositoryRoot = process.cwd();
const dockerBinary = process.env.CF_DOCKER_BIN ?? path.join(repositoryRoot, ".local-tools", "bin", "docker");
const dockerConfig = process.env.CF_DOCKER_CONFIG ?? path.join(repositoryRoot, ".local-tools", "docker-config");
const composeDirectory = path.resolve(
  process.env.CF_GITEA_COMPOSE_DIR ?? path.join(repositoryRoot, "fixtures", "gitea"),
);
const args = [
  "compose",
  "-p",
  "capability-factory-gitea",
  "-f",
  "compose.yml",
  command,
  ...(command === "up" ? ["-d", "--wait"] : []),
];

execFileSync(dockerBinary, args, {
  cwd: composeDirectory,
  stdio: "inherit",
  env: { ...process.env, DOCKER_CONFIG: dockerConfig },
});
