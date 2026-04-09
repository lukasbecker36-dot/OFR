#!/usr/bin/env node
/**
 * OFR → Turso ingestion script.
 *
 * Usage:
 *   npm run ingest                               # full pull of all 4 datasets
 *   npm run ingest -- --dataset fpf              # single dataset
 *   npm run ingest -- --since 2024-01-01         # incremental from date
 *   npm run ingest -- --dataset tff --since 2024-01-01
 *   npm run ingest -- --dry-run                  # parse API, skip DB writes
 *   npm run ingest -- --debug                    # log raw API responses
 */

import { Command } from "commander";
import { getClient, initSchema } from "./db.js";
import {
  fetchMnemonics,
  fetchDataset,
  setDebugMode,
  type MnemonicMeta,
  type SeriesResult,
} from "./api.js";
import type { InStatement } from "@libsql/client";

const DATASETS = ["fpf", "tff", "scoos", "ficc"] as const;
type Dataset = (typeof DATASETS)[number];

const BATCH_SIZE = 500; // rows per batch insert

// ─── CLI ──────────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("ingest")
  .description("Fetch OFR Hedge Fund Monitor data and store in Turso")
  .option("--dataset <name>", "Only ingest one dataset (fpf|tff|scoos|ficc)")
  .option("--since <date>", "Only fetch data from YYYY-MM-DD onward")
  .option("--dry-run", "Parse API responses but do not write to the database")
  .option("--debug", "Log raw API response shapes")
  .parse(process.argv);

const opts = program.opts<{
  dataset?: string;
  since?: string;
  dryRun?: boolean;
  debug?: boolean;
}>();

if (opts.debug) setDebugMode(true);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateDataset(name: string): Dataset {
  if (!(DATASETS as readonly string[]).includes(name)) {
    console.error(`Unknown dataset "${name}". Valid options: ${DATASETS.join(", ")}`);
    process.exit(1);
  }
  return name as Dataset;
}

async function upsertMetadataBatch(
  metas: MnemonicMeta[],
  dryRun: boolean
): Promise<void> {
  if (metas.length === 0) return;
  if (dryRun) {
    console.log(`  [dry-run] Would upsert ${metas.length} metadata rows`);
    return;
  }

  const client = getClient();
  const now = new Date().toISOString().slice(0, 10);

  const stmts: InStatement[] = metas.map((m) => ({
    sql: `INSERT INTO series_metadata (mnemonic, dataset, category, description, frequency, last_updated)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(mnemonic) DO UPDATE SET
            dataset      = excluded.dataset,
            category     = excluded.category,
            description  = excluded.description,
            frequency    = excluded.frequency,
            last_updated = excluded.last_updated`,
    args: [m.mnemonic, m.dataset, m.category ?? null, m.description ?? null, m.frequency ?? null, now],
  }));

  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await client.batch(stmts.slice(i, i + BATCH_SIZE), "write");
  }
}

async function upsertSeriesData(
  series: SeriesResult,
  dryRun: boolean
): Promise<number> {
  if (series.data.length === 0) return 0;

  if (dryRun) {
    console.log(
      `  [dry-run] Would upsert ${series.data.length} data points for ${series.mnemonic}`
    );
    return series.data.length;
  }

  const client = getClient();
  const stmts: InStatement[] = series.data.map((pt) => ({
    sql: `INSERT INTO series_data (mnemonic, date, value)
          VALUES (?, ?, ?)
          ON CONFLICT(mnemonic, date) DO UPDATE SET value = excluded.value`,
    args: [series.mnemonic, pt.date, pt.value],
  }));

  for (let i = 0; i < stmts.length; i += BATCH_SIZE) {
    await client.batch(stmts.slice(i, i + BATCH_SIZE), "write");
  }

  return series.data.length;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dryRun = opts.dryRun ?? false;
  const since = opts.since;
  const targetDatasets: Dataset[] = opts.dataset
    ? [validateDataset(opts.dataset)]
    : [...DATASETS];

  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    console.error(`--since must be in YYYY-MM-DD format, got: ${since}`);
    process.exit(1);
  }

  console.log(`\nOFR → Turso ingestion`);
  console.log(`  Datasets : ${targetDatasets.join(", ")}`);
  console.log(`  Since    : ${since ?? "beginning"}`);
  console.log(`  Dry run  : ${dryRun}`);
  console.log();

  if (!dryRun) {
    console.log("Initialising schema…");
    await initSchema();
    console.log("  ✓ Schema ready\n");
  }

  // Step 1: fetch all mnemonic metadata
  console.log("Fetching mnemonic metadata…");
  let allMeta: MnemonicMeta[] = [];
  try {
    allMeta = await fetchMnemonics();
    console.log(`  ✓ Got ${allMeta.length} mnemonics`);
  } catch (err) {
    console.warn(`  [WARN] Could not fetch mnemonics: ${(err as Error).message}`);
    console.warn("  Metadata will be derived from dataset responses instead.");
  }

  // Filter to target datasets (if metadata has a dataset field)
  const filteredMeta = allMeta.filter(
    (m) => targetDatasets.includes(m.dataset.toLowerCase() as Dataset) || !m.dataset
  );

  await upsertMetadataBatch(filteredMeta, dryRun);
  if (filteredMeta.length > 0) {
    console.log(`  ✓ Upserted ${filteredMeta.length} metadata rows\n`);
  }

  // Step 2: fetch data per dataset
  let totalSeries = 0;
  let totalPoints = 0;

  for (const dataset of targetDatasets) {
    console.log(`Fetching dataset: ${dataset}…`);
    let seriesList: SeriesResult[] = [];

    try {
      seriesList = await fetchDataset(dataset, since);
    } catch (err) {
      console.error(`  [ERROR] Failed to fetch dataset "${dataset}": ${(err as Error).message}`);
      continue;
    }

    console.log(`  ✓ Got ${seriesList.length} series`);

    let datasetPoints = 0;
    let seriesErrors = 0;

    for (const series of seriesList) {
      // Upsert metadata if we have it and it wasn't from the mnemonics call
      if (series.metadata && !allMeta.some((m) => m.mnemonic === series.mnemonic)) {
        await upsertMetadataBatch(
          [
            {
              mnemonic: series.mnemonic,
              dataset: series.metadata.dataset ?? dataset,
              category: series.metadata.category,
              description: series.metadata.description,
              frequency: series.metadata.frequency,
            },
          ],
          dryRun
        );
      }

      try {
        const count = await upsertSeriesData(series, dryRun);
        datasetPoints += count;
      } catch (err) {
        seriesErrors++;
        console.warn(
          `  [WARN] Failed to upsert "${series.mnemonic}": ${(err as Error).message}`
        );
      }
    }

    totalSeries += seriesList.length;
    totalPoints += datasetPoints;

    console.log(
      `  ✓ ${dataset.toUpperCase()}: ${seriesList.length} series, ${datasetPoints} data points` +
        (seriesErrors > 0 ? `, ${seriesErrors} errors` : "")
    );
    console.log();
  }

  console.log(`Done.`);
  console.log(`  Total series : ${totalSeries}`);
  console.log(`  Total points : ${totalPoints}`);
  if (dryRun) console.log(`  (dry-run — nothing was written to the database)`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
