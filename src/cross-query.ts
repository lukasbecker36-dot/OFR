/**
 * Cross-database query module.
 *
 * This is the "killer feature": pull aligned time series from multiple
 * independent Turso databases and merge them on date. This lets you say:
 *
 *   "Give me hedge fund leverage (OFR), Treasury short interest, and
 *    COT speculative positioning for the last 2 years, aligned by date."
 *
 * Each database just needs to have the same schema (series_data table
 * with mnemonic + date + value columns — identical to what ingest.ts creates).
 *
 * Example usage:
 *
 *   import { crossDateRange } from './cross-query.js';
 *
 *   const rows = await crossDateRange([
 *     {
 *       url: process.env.OFR_DB_URL!,
 *       authToken: process.env.OFR_TOKEN!,
 *       mnemonics: ['FPF-ALLQHF_LEVERAGERATIO_AVERAGE'],
 *     },
 *     {
 *       url: process.env.TREASURY_DB_URL!,
 *       authToken: process.env.TREASURY_TOKEN!,
 *       mnemonics: ['US10Y_SHORT_INTEREST'],
 *       label: 'treasury',  // prefix columns to avoid collisions
 *     },
 *     {
 *       url: process.env.CFTC_DB_URL!,
 *       authToken: process.env.CFTC_TOKEN!,
 *       mnemonics: ['COT_SPEC_NET_LONG'],
 *       label: 'cftc',
 *     },
 *   ], '2022-01-01', '2024-01-01');
 *
 *   // rows[0] == { date: "2022-01-07", "FPF-ALLQHF_LEVERAGERATIO_AVERAGE": 1.5,
 *   //              "treasury:US10Y_SHORT_INTEREST": 42.3, "cftc:COT_SPEC_NET_LONG": 125000 }
 */

import { createClient, type Client } from "@libsql/client";
import { getDateRange, type AlignedRow } from "./query.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DbConfig {
  /** Turso database URL, e.g. "libsql://mydb.turso.io" */
  url: string;
  /** Turso auth token (leave empty for local files) */
  authToken?: string;
  /** Mnemonics to pull from this database */
  mnemonics: string[];
  /**
   * Optional column prefix to avoid name collisions across databases.
   * If set, columns become "label:mnemonic" instead of just "mnemonic".
   */
  label?: string;
}

export type CrossRow = Record<string, string | number | null>;

// ─── Implementation ───────────────────────────────────────────────────────────

/**
 * Pull aligned time series from multiple Turso databases and merge on date.
 *
 * The result set is the UNION of all dates found across all databases,
 * with null filling for any mnemonic that has no value on a given date.
 * Rows are sorted ascending by date.
 */
export async function crossDateRange(
  configs: DbConfig[],
  startDate: string,
  endDate: string
): Promise<CrossRow[]> {
  if (configs.length === 0) return [];

  // Create a client per config and query in parallel, then close each client
  const clientsAndConfigs = configs.map((cfg) => ({
    cfg,
    client: createClient({ url: cfg.url, authToken: cfg.authToken }),
  }));

  let perDbResults: Array<{ cfg: DbConfig; rows: AlignedRow[] }>;
  try {
    perDbResults = await Promise.all(
      clientsAndConfigs.map(({ cfg, client }) =>
        getDateRange(startDate, endDate, cfg.mnemonics, client).then((rows) => ({
          cfg,
          rows,
        }))
      )
    );
  } finally {
    for (const { client } of clientsAndConfigs) {
      client.close();
    }
  }

  // Merge all results into a single date-keyed map
  const mergedMap = new Map<string, CrossRow>();

  for (const { cfg, rows } of perDbResults) {
    for (const row of rows) {
      const date = row.date as string;
      if (!mergedMap.has(date)) {
        mergedMap.set(date, { date });
      }
      const merged = mergedMap.get(date)!;

      for (const mnemonic of cfg.mnemonics) {
        const colName = cfg.label ? `${cfg.label}:${mnemonic}` : mnemonic;
        merged[colName] = (row[mnemonic] as number | null) ?? null;
      }
    }
  }

  // Build the full set of column names (preserving insertion order per config)
  const allColumns: string[] = [];
  for (const { cfg } of perDbResults) {
    for (const mnemonic of cfg.mnemonics) {
      const colName = cfg.label ? `${cfg.label}:${mnemonic}` : mnemonic;
      if (!allColumns.includes(colName)) allColumns.push(colName);
    }
  }

  // Sort by date, fill nulls for any missing column
  const sortedDates = [...mergedMap.keys()].sort();
  return sortedDates.map((date) => {
    const row: CrossRow = { date };
    for (const col of allColumns) {
      row[col] = mergedMap.get(date)?.[col] ?? null;
    }
    return row;
  });
}

/**
 * Convenience: get the column names that will appear in crossDateRange results.
 * Useful for building table headers before running the query.
 */
export function getCrossColumnNames(configs: DbConfig[]): string[] {
  const cols: string[] = ["date"];
  for (const cfg of configs) {
    for (const mnemonic of cfg.mnemonics) {
      cols.push(cfg.label ? `${cfg.label}:${mnemonic}` : mnemonic);
    }
  }
  return cols;
}
