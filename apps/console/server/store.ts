import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ConsoleEvent } from "../shared/contracts.js";
import { consoleEventSchema } from "../shared/contracts.js";

export class ConsoleEventStore {
  readonly database: DatabaseSync;

  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS console_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        request_id TEXT NOT NULL,
        type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        body TEXT NOT NULL,
        UNIQUE (tenant_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS console_events_tenant_run
        ON console_events (tenant_id, run_id, sequence);
    `);
  }

  append(event: ConsoleEvent): { inserted: boolean; sequence: number } {
    const parsed = consoleEventSchema.parse(event);
    const result = this.database.prepare(`
      INSERT OR IGNORE INTO console_events
        (tenant_id, event_id, run_id, request_id, type, occurred_at, body)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(parsed.tenantId, parsed.eventId, parsed.runId, parsed.requestId, parsed.type, parsed.occurredAt, JSON.stringify(parsed));
    const row = this.database.prepare(
      "SELECT sequence FROM console_events WHERE tenant_id = ? AND event_id = ?",
    ).get(parsed.tenantId, parsed.eventId) as { sequence: number };
    return { inserted: result.changes === 1, sequence: row.sequence };
  }

  list(tenantId: string, after = 0): Array<{ sequence: number; event: ConsoleEvent }> {
    const rows = this.database.prepare(`
      SELECT sequence, body FROM console_events
      WHERE tenant_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(tenantId, after) as Array<{ sequence: number; body: string }>;
    return rows.map((row) => ({ sequence: row.sequence, event: consoleEventSchema.parse(JSON.parse(row.body)) }));
  }

  listRun(tenantId: string, runId: string) {
    return this.list(tenantId).filter(({ event }) => event.runId === runId);
  }

  close() { this.database.close(); }
}
