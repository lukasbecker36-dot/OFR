#!/usr/bin/env node
/**
 * OFR query CLI.
 *
 * Usage:
 *   npm run query -- search "leverage"
 *   npm run query -- series FPF-ALLQHF_LEVERAGERATIO_AVERAGE
 *   npm run query -- series FPF-ALLQHF_LEVERAGERATIO_AVERAGE --start 2023-01-01 --end 2024-01-01
 *   npm run query -- range 2023-01-01 2024-01-01 FPF-ALLQHF_LEVERAGERATIO_AVERAGE FPF-ALLQHF_GAV_SUM
 *   npm run query -- latest-by-category "Leverage"
 *   npm run query -- datasets
 *   npm run query -- list [--dataset fpf]
 */

import { Command } from "commander";
import "dotenv/config";
import {
  getSeriesByMnemonic,
  searchSeries,
  getLatestByCategory,
  getDateRange,
  listDatasets,
  listSeries,
  type AlignedRow,
  type DataPoint,
  type SeriesMeta,
  type LatestValue,
} from "./query.js";

// ─── Table rendering ──────────────────────────────────────────────────────────

function pad(s: string, n: number, right = false): string {
  const str = s.length > n ? s.slice(0, n - 1) + "…" : s;
  return right ? str.padStart(n) : str.padEnd(n);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.min(60, Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)))
  );
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const header = headers.map((h, i) => pad(h, widths[i])).join(" │ ");

  console.log(header);
  console.log(sep);
  for (const row of rows) {
    const rightAlign = new Set([headers.indexOf("value"), headers.indexOf("Value")]);
    console.log(
      row.map((cell, i) => pad(cell ?? "", widths[i], rightAlign.has(i))).join(" │ ")
    );
  }
  console.log(`\n${rows.length} row${rows.length === 1 ? "" : "s"}`);
}

function fmtValue(v: number | null): string {
  if (v === null) return "null";
  return v.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

// ─── Commands ─────────────────────────────────────────────────────────────────

const program = new Command();
program.name("query").description("Query the OFR Turso database");

// search
program
  .command("search <keyword>")
  .description("Search series metadata for a keyword")
  .action(async (keyword: string) => {
    const results: SeriesMeta[] = await searchSeries(keyword);
    if (results.length === 0) {
      console.log(`No series found matching "${keyword}"`);
      return;
    }
    printTable(
      ["mnemonic", "dataset", "freq", "description"],
      results.map((r) => [
        r.mnemonic,
        r.dataset,
        r.frequency ?? "",
        r.description ?? "",
      ])
    );
  });

// series
program
  .command("series <mnemonic>")
  .description("Dump time series data for a mnemonic")
  .option("--start <date>", "Start date YYYY-MM-DD")
  .option("--end <date>", "End date YYYY-MM-DD")
  .action(async (mnemonic: string, opts: { start?: string; end?: string }) => {
    const data: DataPoint[] = await getSeriesByMnemonic(mnemonic, opts.start, opts.end);
    if (data.length === 0) {
      console.log(`No data found for "${mnemonic}"`);
      return;
    }
    printTable(
      ["date", "value"],
      data.map((d) => [d.date, fmtValue(d.value)])
    );
  });

// range
program
  .command("range <startDate> <endDate> [mnemonics...]")
  .description("Pull multiple series aligned by date")
  .action(async (startDate: string, endDate: string, mnemonics: string[]) => {
    if (mnemonics.length === 0) {
      console.error("Provide at least one mnemonic");
      process.exit(1);
    }
    const rows: AlignedRow[] = await getDateRange(startDate, endDate, mnemonics);
    if (rows.length === 0) {
      console.log("No data found for the given range and mnemonics");
      return;
    }
    const headers = ["date", ...mnemonics];
    printTable(
      headers,
      rows.map((row) =>
        headers.map((h) => (h === "date" ? String(row.date) : fmtValue(row[h] as number | null)))
      )
    );
  });

// latest-by-category
program
  .command("latest-by-category <category>")
  .description("Get the most recent value for all series in a category")
  .action(async (category: string) => {
    const results: LatestValue[] = await getLatestByCategory(category);
    if (results.length === 0) {
      console.log(`No series found for category "${category}"`);
      return;
    }
    printTable(
      ["mnemonic", "date", "value", "description"],
      results.map((r) => [r.mnemonic, r.date, fmtValue(r.value), r.description ?? ""])
    );
  });

// datasets
program
  .command("datasets")
  .description("List all available datasets")
  .action(async () => {
    const datasets = await listDatasets();
    if (datasets.length === 0) {
      console.log("No data in the database yet. Run: npm run ingest");
      return;
    }
    console.log("Available datasets:");
    for (const d of datasets) console.log(`  ${d}`);
  });

// list
program
  .command("list")
  .description("List all series (optionally filtered by dataset)")
  .option("--dataset <name>", "Filter by dataset name")
  .action(async (opts: { dataset?: string }) => {
    const series: SeriesMeta[] = await listSeries(opts.dataset);
    if (series.length === 0) {
      console.log("No series found");
      return;
    }
    printTable(
      ["mnemonic", "dataset", "freq", "description"],
      series.map((r) => [r.mnemonic, r.dataset, r.frequency ?? "", r.description ?? ""])
    );
  });

program.parse(process.argv);
