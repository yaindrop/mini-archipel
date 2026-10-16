import { DatabaseSync } from "node:sqlite";

/**
 * Three-tier time-series tables: raw (1s, 24h), mid (10s, 30d), coarse
 * (1m, 1y). New agent namespaces land in the same narrow schema with no
 * migration; queryRange picks the tier from the requested window.
 */
const RAW_TTL = 86_400_000;
const MID_TTL = 30 * 86_400_000;

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS samples_raw (
        host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raw_lookup ON samples_raw(host, key, ts);
      CREATE TABLE IF NOT EXISTS samples_mid (
        host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (host, key, ts)
      );
      CREATE TABLE IF NOT EXISTS samples_coarse (
        host TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL, value REAL NOT NULL,
        PRIMARY KEY (host, key, ts)
      );
      CREATE TABLE IF NOT EXISTS scan_docs (
        host TEXT NOT NULL, ns TEXT NOT NULL, ts INTEGER NOT NULL, doc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scan_lookup ON scan_docs(host, ns, ts);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    `);
  }

  insertSamples(
    rows: Array<{ host: string; key: string; ts: number; value: number }>,
  ): void {
    if (rows.length === 0) return;
    const insert = this.db.prepare(
      "INSERT INTO samples_raw (host, key, ts, value) VALUES (?, ?, ?, ?)",
    );
    this.db.exec("BEGIN");
    try {
      for (const row of rows) insert.run(row.host, row.key, row.ts, row.value);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  insertScanDoc(host: string, ns: string, ts: number, doc: unknown): void {
    this.db
      .prepare("INSERT INTO scan_docs (host, ns, ts, doc) VALUES (?, ?, ?, ?)")
      .run(host, ns, ts, JSON.stringify(doc));
  }

  queryRange(
    host: string,
    key: string,
    fromTs: number,
    toTs: number,
  ): Array<{ ts: number; value: number }> {
    const table =
      toTs - fromTs > 6 * 86_400_000 ? "samples_coarse" : "samples_mid";
    const mid = this.db.prepare(
      `SELECT ts, value FROM ${table} WHERE host = ? AND key = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
    );
    const rows = mid.all(host, key, fromTs, toTs) as Array<{
      ts: number;
      value: number;
    }>;
    const raw = this.db.prepare(
      `SELECT ts, value FROM samples_raw WHERE host = ? AND key = ? AND ts BETWEEN ? AND ? ORDER BY ts`,
    );
    return [
      ...rows,
      ...(raw.all(host, key, fromTs, toTs) as Array<{
        ts: number;
        value: number;
      }>),
    ];
  }

  downsampleAndPrune(): void {
    const now = Date.now();
    const rawKeep = now - RAW_TTL;
    const midKeep = now - MID_TTL;
    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        INSERT OR IGNORE INTO samples_mid (host, key, ts, value)
        SELECT host, key, (ts / 10000) * 10000, AVG(value)
        FROM samples_raw WHERE ts < ${rawKeep}
        GROUP BY host, key, (ts / 10000) * 10000`);
      this.db.exec(`DELETE FROM samples_raw WHERE ts < ${rawKeep}`);
      this.db.exec(`
        INSERT OR IGNORE INTO samples_coarse (host, key, ts, value)
        SELECT host, key, (ts / 60000) * 60000, AVG(value)
        FROM samples_mid WHERE ts < ${midKeep}
        GROUP BY host, key, (ts / 60000) * 60000`);
      this.db.exec(`DELETE FROM samples_mid WHERE ts < ${midKeep}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_downsample', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(String(now));
  }

  close(): void {
    this.db.close();
  }
}
