#!/usr/bin/env node
/**
 * Export the Turso database to CSV files.
 *
 * Outputs:
 *   metadata.csv   — all series_metadata rows
 *   data.csv       — all series_data rows (mnemonic, date, value)
 *   combined.csv   — joined: mnemonic, dataset, description, frequency, date, value
 *
 * Usage:
 *   npm run export-csv
 *   npm run export-csv -- --dataset fpf
 *   npm run export-csv -- --mnemonic FPF-ALLQHF_GAV_SUM
 */

import { writeFileSync } from "fs";
import { Command } from "commander";
import "dotenv/config";
import { getClient } from "./db.js";

const program = new Command();
program
  .option("--dataset <name>", "Filter by dataset (fpf|tff|scoos|ficc)")
  .option("--mnemonic <name>", "Filter by a single mnemonic")
  .option("--since <date>", "Only export data from YYYY-MM-DD onward")
  .parse(process.argv);

const opts = program.opts<{ dataset?: string; mnemonic?: string; since?: string }>();

function toCsv(headers: string[], rows: unknown[][]): string {
  const escape = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };
  return [headers.join(","), ...rows.map((r) => r.map(escape).join(","))].join("\n");
}

async function main() {
  const client = getClient();

  // ── metadata.csv ──────────────────────────────────────────────────────────
  const metaResult = await client.execute({
    sql: opts.dataset
      ? "SELECT * FROM series_metadata WHERE dataset = ? ORDER BY mnemonic"
      : "SELECT * FROM series_metadata ORDER BY dataset, mnemonic",
    args: opts.dataset ? [opts.dataset] : [],
  });

  const metaCsv = toCsv(
    ["mnemonic", "dataset", "category", "description", "frequency", "last_updated"],
    metaResult.rows.map((r) => [
      r.mnemonic, r.dataset, r.category, r.description, r.frequency, r.last_updated,
    ])
  );
  writeFileSync("metadata.csv", metaCsv);
  console.log(`✓ metadata.csv — ${metaResult.rows.length} series`);

  // ── data.csv ──────────────────────────────────────────────────────────────
  let dataSql = "SELECT mnemonic, date, value FROM series_data";
  const dataArgs: (string)[] = [];
  const conditions: string[] = [];

  if (opts.mnemonic) {
    conditions.push("mnemonic = ?");
    dataArgs.push(opts.mnemonic);
  } else if (opts.dataset) {
    conditions.push("mnemonic IN (SELECT mnemonic FROM series_metadata WHERE dataset = ?)");
    dataArgs.push(opts.dataset);
  }
  if (opts.since) {
    conditions.push("date >= ?");
    dataArgs.push(opts.since);
  }
  if (conditions.length) dataSql += " WHERE " + conditions.join(" AND ");
  dataSql += " ORDER BY mnemonic, date";

  const dataResult = await client.execute({ sql: dataSql, args: dataArgs });

  const dataCsv = toCsv(
    ["mnemonic", "date", "value"],
    dataResult.rows.map((r) => [r.mnemonic, r.date, r.value])
  );
  writeFileSync("data.csv", dataCsv);
  console.log(`✓ data.csv     — ${dataResult.rows.length} data points`);

  // ── combined.csv ──────────────────────────────────────────────────────────
  let combinedSql = `
    SELECT sd.mnemonic, sm.dataset, sm.category, sm.description, sm.frequency,
           sd.date, sd.value
    FROM series_data sd
    JOIN series_metadata sm ON sd.mnemonic = sm.mnemonic`;
  const combinedArgs: string[] = [];
  const conds: string[] = [];

  if (opts.mnemonic) { conds.push("sd.mnemonic = ?"); combinedArgs.push(opts.mnemonic); }
  else if (opts.dataset) { conds.push("sm.dataset = ?"); combinedArgs.push(opts.dataset); }
  if (opts.since) { conds.push("sd.date >= ?"); combinedArgs.push(opts.since); }
  if (conds.length) combinedSql += " WHERE " + conds.join(" AND ");
  combinedSql += " ORDER BY sd.mnemonic, sd.date";

  const combinedResult = await client.execute({ sql: combinedSql, args: combinedArgs });

  const combinedCsv = toCsv(
    ["mnemonic", "dataset", "category", "description", "frequency", "date", "value"],
    combinedResult.rows.map((r) => [
      r.mnemonic, r.dataset, r.category, r.description, r.frequency, r.date, r.value,
    ])
  );
  writeFileSync("combined.csv", combinedCsv);
  console.log(`✓ combined.csv — ${combinedResult.rows.length} rows`);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
