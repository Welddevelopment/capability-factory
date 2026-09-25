import "dotenv/config";
import { execFileSync } from "node:child_process";
import path from "node:path";

const command = process.argv[2];
if (command !== "up" && command !== "stop") {
  throw new Error("Usage: run-pilot-erpnext-compose.ts <up|stop>");
}

const repositoryRoot = process.cwd();
const dockerBinary = process.env.CF_DOCKER_BIN ?? path.join(repositoryRoot, ".local-tools", "bin", "docker");
const dockerConfig = process.env.CF_DOCKER_CONFIG ?? path.join(repositoryRoot, ".local-tools", "docker-config");
const composeDirectory = path.resolve(process.env.CF_ERPNEXT_COMPOSE_DIR ?? path.join(repositoryRoot, "fixtures", "erpnext"));
const args = [
  "compose",
  "-p",
  "capability-factory-erpnext",
  "-f",
  "compose.yml",
  command,
  ...(command === "up" ? ["-d"] : []),
];

execFileSync(dockerBinary, args, {
  cwd: composeDirectory,
  stdio: "inherit",
  env: { ...process.env, DOCKER_CONFIG: dockerConfig },
});
