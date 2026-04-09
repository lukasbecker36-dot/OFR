/**
 * Query helpers for the OFR Turso database.
 *
 * All functions accept an optional `client` parameter so they can be reused
 * by cross-query.ts with clients pointed at different Turso databases.
 */

import { getClient } from "./db.js";
import type { Client } from "@libsql/client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DataPoint {
  date: string;
  value: number | null;
}

export interface SeriesMeta {
  mnemonic: string;
  dataset: string;
  category: string | null;
  description: string | null;
  frequency: string | null;
  last_updated: string | null;
}

export interface LatestValue extends SeriesMeta {
  date: string;
  value: number | null;
}

export type AlignedRow = Record<string, string | number | null>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function client(c?: Client): Client {
  return c ?? getClient();
}

// ─── Query functions ──────────────────────────────────────────────────────────

/**
 * Return time series data for a single mnemonic.
 * Optionally filter by date range (inclusive, YYYY-MM-DD).
 */
export async function getSeriesByMnemonic(
  mnemonic: string,
  startDate?: string,
  endDate?: string,
  c?: Client
): Promise<DataPoint[]> {
  let sql = "SELECT date, value FROM series_data WHERE mnemonic = ?";
  const args: (string | null)[] = [mnemonic];

  if (startDate) {
    sql += " AND date >= ?";
    args.push(startDate);
  }
  if (endDate) {
    sql += " AND date <= ?";
    args.push(endDate);
  }
  sql += " ORDER BY date ASC";

  const result = await client(c).execute({ sql, args });
  return result.rows.map((r) => ({
    date: r.date as string,
    value: r.value as number | null,
  }));
}

/**
 * Search series metadata for a keyword.
 * Matches against mnemonic, description, and category (case-insensitive).
 */
export async function searchSeries(
  keyword: string,
  c?: Client
): Promise<SeriesMeta[]> {
  const like = `%${keyword}%`;
  const result = await client(c).execute({
    sql: `SELECT mnemonic, dataset, category, description, frequency, last_updated
          FROM series_metadata
          WHERE mnemonic LIKE ?
             OR description LIKE ?
             OR category LIKE ?
          ORDER BY dataset, mnemonic`,
    args: [like, like, like],
  });

  return result.rows.map((r) => ({
    mnemonic: r.mnemonic as string,
    dataset: r.dataset as string,
    category: r.category as string | null,
    description: r.description as string | null,
    frequency: r.frequency as string | null,
    last_updated: r.last_updated as string | null,
  }));
}

/**
 * Get the most recent value for every series in a given category.
 */
export async function getLatestByCategory(
  category: string,
  c?: Client
): Promise<LatestValue[]> {
  const result = await client(c).execute({
    sql: `SELECT sm.mnemonic, sm.dataset, sm.category, sm.description,
                 sm.frequency, sm.last_updated,
                 sd.date, sd.value
          FROM series_metadata sm
          JOIN series_data sd ON sm.mnemonic = sd.mnemonic
          WHERE sm.category = ?
            AND sd.date = (
              SELECT MAX(date) FROM series_data WHERE mnemonic = sm.mnemonic
            )
          ORDER BY sm.mnemonic`,
    args: [category],
  });

  return result.rows.map((r) => ({
    mnemonic: r.mnemonic as string,
    dataset: r.dataset as string,
    category: r.category as string | null,
    description: r.description as string | null,
    frequency: r.frequency as string | null,
    last_updated: r.last_updated as string | null,
    date: r.date as string,
    value: r.value as number | null,
  }));
}

/**
 * Pull multiple series aligned by date.
 *
 * Returns an array of rows like:
 *   { date: "2023-01-01", "FPF-ALLQHF_LEVERAGERATIO_AVERAGE": 1.5, "FPF-ALLQHF_GAV_SUM": 2e9 }
 *
 * Dates with no value for a given mnemonic appear as null (not omitted),
 * so every row has the same shape — important for downstream joins.
 *
 * The union of all dates across all requested series is returned.
 */
export async function getDateRange(
  startDate: string,
  endDate: string,
  mnemonics: string[],
  c?: Client
): Promise<AlignedRow[]> {
  if (mnemonics.length === 0) return [];

  const placeholders = mnemonics.map(() => "?").join(", ");
  const result = await client(c).execute({
    sql: `SELECT mnemonic, date, value
          FROM series_data
          WHERE mnemonic IN (${placeholders})
            AND date >= ?
            AND date <= ?
          ORDER BY date ASC`,
    args: [...mnemonics, startDate, endDate],
  });

  // Build a date → {mnemonic: value} map
  const dateMap = new Map<string, Record<string, number | null>>();

  for (const row of result.rows) {
    const date = row.date as string;
    const mnemonic = row.mnemonic as string;
    const value = row.value as number | null;

    if (!dateMap.has(date)) {
      dateMap.set(date, {});
    }
    dateMap.get(date)![mnemonic] = value;
  }

  // Expand to aligned rows, filling null for missing mnemonics
  const sorted = [...dateMap.keys()].sort();
  return sorted.map((date) => {
    const row: AlignedRow = { date };
    for (const mnemonic of mnemonics) {
      row[mnemonic] = dateMap.get(date)?.[mnemonic] ?? null;
    }
    return row;
  });
}

/**
 * List all known datasets.
 */
export async function listDatasets(c?: Client): Promise<string[]> {
  const result = await client(c).execute({
    sql: "SELECT DISTINCT dataset FROM series_metadata ORDER BY dataset",
    args: [],
  });
  return result.rows.map((r) => r.dataset as string);
}

/**
 * List all series metadata, optionally filtered by dataset.
 */
export async function listSeries(dataset?: string, c?: Client): Promise<SeriesMeta[]> {
  const result = await client(c).execute({
    sql: dataset
      ? "SELECT * FROM series_metadata WHERE dataset = ? ORDER BY mnemonic"
      : "SELECT * FROM series_metadata ORDER BY dataset, mnemonic",
    args: dataset ? [dataset] : [],
  });

  return result.rows.map((r) => ({
    mnemonic: r.mnemonic as string,
    dataset: r.dataset as string,
    category: r.category as string | null,
    description: r.description as string | null,
    frequency: r.frequency as string | null,
    last_updated: r.last_updated as string | null,
  }));
}
