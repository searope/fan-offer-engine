import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * POC persistence: SQLite via Node's built-in node:sqlite (no native build step on Windows).
 * The schema is the production shape (Postgres in prod): unique idempotency keys on the
 * outbox, contact history, and promo codes are what make double-sends impossible.
 */
export const DATA_DIR = path.join(process.cwd(), "data");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS fans (
  tenant_id TEXT NOT NULL, fan_id TEXT NOT NULL, email TEXT NOT NULL,
  email_opt_in INTEGER NOT NULL, push_opt_in INTEGER NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, fan_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, as_of TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT, model_name TEXT, stats_json TEXT
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  decision_key TEXT NOT NULL, tenant_id TEXT, fan_id TEXT, match_id TEXT NOT NULL,
  cart_ids_json TEXT NOT NULL, outcome TEXT NOT NULL, reason_codes_json TEXT NOT NULL, reason TEXT NOT NULL,
  proposal_json TEXT, copy_json TEXT, copy_source TEXT, copy_fallback_reason TEXT, copy_notes_json TEXT, model_name TEXT,
  status TEXT NOT NULL, status_detail TEXT,
  idempotency_key TEXT UNIQUE,  -- one proposal per fan x match x touch, ever
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER, at TEXT NOT NULL,
  actor TEXT NOT NULL, action TEXT NOT NULL, detail_json TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT NOT NULL UNIQUE,
  proposal_id INTEGER NOT NULL, channel TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, provider_message_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contact_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id TEXT NOT NULL, fan_id TEXT NOT NULL, match_id TEXT,
  channel TEXT NOT NULL, offer_type TEXT NOT NULL, sent_at TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS promo_codes (
  code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, fan_id TEXT NOT NULL, kind TEXT NOT NULL,
  percent_off INTEGER NOT NULL CHECK (percent_off BETWEEN 1 AND 15),
  max_value_cents INTEGER CHECK (max_value_cents IS NULL OR max_value_cents > 0),
  max_redemptions INTEGER NOT NULL DEFAULT 1 CHECK (max_redemptions = 1),
  idempotency_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, redeemed_at TEXT,
  CHECK (kind <> 'merch_addon' OR max_value_cents IS NOT NULL)  -- a merch voucher is always capped
);
CREATE TABLE IF NOT EXISTS sales_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, proposal_id INTEGER NOT NULL, tenant_id TEXT NOT NULL, fan_id TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const g = globalThis as unknown as { __offerDb?: DatabaseSync };

export function db(): DatabaseSync {
  if (!g.__offerDb) {
    mkdirSync(DATA_DIR, { recursive: true });
    const d = new DatabaseSync(path.join(DATA_DIR, "offers.db"));
    d.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    d.exec(SCHEMA);
    // Migration for databases created before vouchers had a cap.
    const cols = d.prepare("PRAGMA table_info(promo_codes)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "max_value_cents")) {
      d.exec("ALTER TABLE promo_codes ADD COLUMN max_value_cents INTEGER CHECK (max_value_cents IS NULL OR max_value_cents > 0)");
    }
    g.__offerDb = d;
  }
  return g.__offerDb;
}

export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

export function getSetting(key: string, fallback: string): string {
  const row = db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? fallback;
}

export function setSetting(key: string, value: string) {
  db().prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

export function resetDb() {
  const d = db();
  for (const t of ["audit_log", "outbox", "contact_history", "promo_codes", "sales_tasks", "proposals", "runs", "fans", "settings"]) d.exec(`DELETE FROM ${t}`);
}
