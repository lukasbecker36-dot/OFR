import { createClient, type Client } from "@libsql/client";
import "dotenv/config";

let _client: Client | null = null;

export function getClient(): Client {
  if (_client) return _client;

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    throw new Error(
      "TURSO_DATABASE_URL is not set. Copy .env.example to .env and fill in your credentials."
    );
  }

  _client = createClient({ url, authToken });
  return _client;
}

export async function initSchema(): Promise<void> {
  const client = getClient();

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS series_metadata (
      mnemonic     TEXT PRIMARY KEY,
      dataset      TEXT NOT NULL,
      category     TEXT,
      description  TEXT,
      frequency    TEXT,
      last_updated TEXT
    );

    CREATE TABLE IF NOT EXISTS series_data (
      mnemonic TEXT NOT NULL,
      date     TEXT NOT NULL,
      value    REAL,
      PRIMARY KEY (mnemonic, date)
    );

    CREATE INDEX IF NOT EXISTS idx_series_data_date
      ON series_data(date);

    CREATE INDEX IF NOT EXISTS idx_series_data_mnemonic_date
      ON series_data(mnemonic, date);
  `);
}
