import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Disposable native Dealer Desk world (FICTIONAL) — lifecycle and the
 * independent observation channel for the native-ui family.
 *
 * The world owns: launching the bundled app via Launch Services (a bare
 * binary serves an empty AX tree — hard-won lesson, see native/dealer-desk/
 * build.sh), resetting the disposable database, tearing the app down, and
 * reading state through a SEPARATE read-only SQLite connection that never
 * trusts the UI.
 */

export interface NativeDealerDeskWorld {
  pid: number;
  databasePath: string;
  countRestockRequests(): number;
  listRestockRequests(): { item: string; quantity: number }[];
  stop(): void;
}

const BUNDLE_RELATIVE = path.join("native", "dealer-desk", "DealerDesk.app");
const BINARY_RELATIVE = path.join(BUNDLE_RELATIVE, "Contents", "MacOS", "dealer-desk");

export async function startNativeDealerDeskWorld(options: {
  repositoryRoot: string;
  dataDirectory: string;
}): Promise<NativeDealerDeskWorld> {
  const bundle = path.join(options.repositoryRoot, BUNDLE_RELATIVE);
  if (!fs.existsSync(path.join(options.repositoryRoot, BINARY_RELATIVE))) {
    throw new Error(`Dealer Desk app not built; run ${path.join("native", "dealer-desk", "build.sh")} first.`);
  }
  fs.mkdirSync(options.dataDirectory, { recursive: true, mode: 0o700 });
  const databasePath = path.join(options.dataDirectory, `dealer-desk-${Date.now()}.sqlite`);

  execFileSync("/usr/bin/open", ["-n", bundle, "--args", "--db", databasePath], { timeout: 30_000 });

  const pid = await waitForPid(options.repositoryRoot);
  await waitForSchema(databasePath);
  await waitForAccessibility(options.repositoryRoot, pid);

  return {
    pid,
    databasePath,
    countRestockRequests: () => withReadOnly(databasePath, (db) => {
      const row = db.prepare("SELECT COUNT(*) AS n FROM restock_requests").get() as { n: number };
      return row.n;
    }),
    listRestockRequests: () => withReadOnly(databasePath, (db) =>
      db.prepare("SELECT item, quantity FROM restock_requests ORDER BY id").all() as { item: string; quantity: number }[],
    ),
    stop: () => {
      try {
        execFileSync("/bin/kill", [String(pid)], { timeout: 5_000 });
      } catch {
        // already gone — teardown must not throw
      }
    },
  };
}

function withReadOnly<T>(databasePath: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

async function waitForPid(repositoryRoot: string): Promise<number> {
  const binary = path.join(repositoryRoot, BINARY_RELATIVE);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const out = execFileSync("/usr/bin/pgrep", ["-n", "-f", binary], { encoding: "utf8", timeout: 5_000 }).trim();
      if (out) return Number(out);
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Dealer Desk app did not start within 15s");
}

async function waitForAccessibility(repositoryRoot: string, pid: number): Promise<void> {
  const helper = path.join(repositoryRoot, "native", "dealer-desk", "ax-helper");
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const raw = execFileSync(helper, ["snapshot", String(pid)], { encoding: "utf8", timeout: 10_000 });
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return;
    } catch {
      // helper refusal or AX not ready — keep waiting
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Dealer Desk accessibility tree did not become readable within 15s");
}

async function waitForSchema(databasePath: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (fs.existsSync(databasePath)) {
      try {
        withReadOnly(databasePath, (db) => db.prepare("SELECT COUNT(*) FROM restock_requests").get());
        return;
      } catch {
        // schema not ready yet
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Dealer Desk schema did not appear within 15s");
}
