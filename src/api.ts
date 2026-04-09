/**
 * OFR Hedge Fund Monitor API client.
 *
 * Actual response formats (confirmed via diagnostic):
 *
 * GET /metadata/mnemonics
 *   → string[]  e.g. ["FICC-SPONSORED_REPO_VOL", "FPF-ALLQHF_GAV_SUM", ...]
 *
 * GET /series/dataset?dataset=fpf
 *   → {
 *       short_name: string,
 *       long_name: string,
 *       timeseries: {
 *         [mnemonic]: {
 *           timeseries: { aggregation: [["YYYY-MM-DD", number], ...] },
 *           metadata: {
 *             mnemonic: string,
 *             description: { name: string, notes: string, description: string },
 *             schedule: { observation_frequency: string, last_update: string },
 *             release: { short_name: string, frequency: string, long_name: string },
 *             unit: { type: string, name: string }
 *           }
 *         }
 *       }
 *     }
 *
 * GET /series/timeseries?mnemonic=X
 *   → same shape as a single entry inside dataset.timeseries (unconfirmed, handled defensively)
 *
 * GET /metadata/search?query=X
 *   → [] (appears to be non-functional or empty)
 */

const BASE_URL = "https://data.financialresearch.gov/hf/v1";
const DATASETS = ["fpf", "tff", "scoos", "ficc"] as const;
export type Dataset = (typeof DATASETS)[number];

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MnemonicMeta {
  mnemonic: string;
  dataset: string;
  category?: string;
  description?: string;
  frequency?: string;
}

export interface TimeSeriesPoint {
  date: string; // always YYYY-MM-DD — the cross-DB join key
  value: number | null;
}

export interface SeriesResult {
  mnemonic: string;
  metadata?: Partial<MnemonicMeta>;
  data: TimeSeriesPoint[];
}

// ─── Internal config ──────────────────────────────────────────────────────────

let debugMode = false;

export function setDebugMode(on: boolean): void {
  debugMode = on;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Infer dataset name from mnemonic prefix (e.g. "FPF-..." → "fpf"). */
function inferDataset(mnemonic: string): string {
  return mnemonic.split("-")[0].toLowerCase();
}

/**
 * Normalize a date value to YYYY-MM-DD.
 * The OFR API already returns ISO date strings, but this handles edge cases
 * (Unix ms timestamps from Highcharts, quarter notation, etc.).
 */
export function normalizeDate(raw: string | number): string {
  if (typeof raw === "number" || /^\d{10,13}$/.test(String(raw))) {
    const n = Number(raw);
    const ms = n > 1e10 ? n : n * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Quarter notation: "2024Q1" → "2024-01-01"
  const qMatch = s.match(/^(\d{4})Q(\d)$/i);
  if (qMatch) {
    const quarterStart = ["01", "04", "07", "10"][parseInt(qMatch[2]) - 1];
    return `${qMatch[1]}-${quarterStart}-01`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw new Error(`Cannot normalise date: ${JSON.stringify(raw)}`);
}

/**
 * Parse an aggregation array: [["YYYY-MM-DD", value], ...]
 * This is the actual format returned by the OFR dataset endpoint.
 */
function parseAggregation(aggregation: unknown): TimeSeriesPoint[] {
  if (!Array.isArray(aggregation)) return [];
  const points: TimeSeriesPoint[] = [];
  for (const pair of aggregation) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    try {
      const date = normalizeDate(pair[0] as string | number);
      const raw = pair[1];
      const value = raw === null || raw === undefined ? null : Number(raw);
      points.push({ date, value: value !== null && isFinite(value) ? value : null });
    } catch {
      // skip malformed entries
    }
  }
  return points;
}

/**
 * Extract rich metadata from the nested metadata object inside a series entry.
 *
 * Structure:
 *   metadata.description.name    → human-readable series name
 *   metadata.schedule.observation_frequency → "Quarterly", "Monthly", etc.
 *   metadata.schedule.last_update           → "2026-03-11 16:35:38"
 *   metadata.release.short_name             → category / release name
 */
function parseSeriesMetadata(
  meta: Record<string, unknown>,
  dataset: string
): Partial<MnemonicMeta> {
  const desc = (meta.description ?? {}) as Record<string, unknown>;
  const schedule = (meta.schedule ?? {}) as Record<string, unknown>;
  const release = (meta.release ?? {}) as Record<string, unknown>;

  return {
    dataset,
    description: String(desc.name ?? desc.description ?? ""),
    category: String(release.short_name ?? release.long_name ?? ""),
    frequency: String(schedule.observation_frequency ?? release.frequency ?? ""),
  };
}

// ─── Rate-limiting + retry fetch ──────────────────────────────────────────────

const DELAY_MS = 500;
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _lastRequestTime = 0;

async function apiFetch(url: string): Promise<unknown> {
  const now = Date.now();
  const wait = DELAY_MS - (now - _lastRequestTime);
  if (wait > 0) await sleep(wait);

  let attempt = 0;
  while (true) {
    _lastRequestTime = Date.now();
    if (debugMode) console.log(`  [DEBUG] GET ${url}`);

    let resp: Response;
    try {
      resp = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": "ofr-turso-pipeline/1.0" },
      });
    } catch (err) {
      if (attempt >= MAX_RETRIES) throw err;
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`  [WARN] Network error, retrying in ${backoff}ms…`, (err as Error).message);
      await sleep(backoff);
      attempt++;
      continue;
    }

    if (resp.ok) {
      const body = await resp.json();
      if (debugMode) {
        const preview = JSON.stringify(body).slice(0, 400);
        console.log(`  [DEBUG] Response: ${preview}`);
      }
      return body;
    }

    if ((resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES) {
      const backoff = 1000 * Math.pow(2, attempt);
      console.warn(`  [WARN] HTTP ${resp.status}, retrying in ${backoff}ms…`);
      await sleep(backoff);
      attempt++;
      continue;
    }

    const text = await resp.text().catch(() => "");
    throw new Error(`OFR API error: HTTP ${resp.status} ${text.slice(0, 100)} for ${url}`);
  }
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

// ─── Public API functions ──────────────────────────────────────────────────────

/**
 * Fetch the mnemonic catalogue.
 * Returns a flat string[] — dataset is inferred from the mnemonic prefix.
 */
export async function fetchMnemonics(): Promise<MnemonicMeta[]> {
  const raw = await apiFetch(`${BASE_URL}/metadata/mnemonics`);

  // Response is a plain string[]: ["FICC-SPONSORED_REPO_VOL", "FPF-ALLQHF_GAV_SUM", ...]
  if (!Array.isArray(raw)) {
    console.warn("  [WARN] /metadata/mnemonics: unexpected response shape");
    return [];
  }

  return raw
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .map((mnemonic) => ({
      mnemonic,
      dataset: inferDataset(mnemonic),
    }));
}

/**
 * Fetch all series for a dataset, including embedded metadata and data points.
 *
 * Response shape:
 *   {
 *     short_name, long_name,
 *     timeseries: {
 *       [mnemonic]: {
 *         timeseries: { aggregation: [["YYYY-MM-DD", value], ...] },
 *         metadata: { description: {name}, schedule: {observation_frequency}, release: {short_name} }
 *       }
 *     }
 *   }
 */
export async function fetchDataset(
  dataset: string,
  since?: string
): Promise<SeriesResult[]> {
  const url = buildUrl("/series/dataset", {
    dataset,
    ...(since ? { start_date: since } : {}),
  });

  const raw = await apiFetch(url);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    console.warn(`  [WARN] Unexpected top-level shape for dataset "${dataset}"`);
    return [];
  }

  const obj = raw as Record<string, unknown>;
  const tsMap = obj.timeseries;

  if (!tsMap || typeof tsMap !== "object" || Array.isArray(tsMap)) {
    console.warn(`  [WARN] No "timeseries" key in dataset "${dataset}" response`);
    return [];
  }

  const results: SeriesResult[] = [];

  for (const [mnemonic, entry] of Object.entries(tsMap as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    // Data: e.timeseries.aggregation
    const innerTs = (e.timeseries ?? {}) as Record<string, unknown>;
    const points = parseAggregation(innerTs.aggregation);

    // Metadata: e.metadata
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    const parsedMeta = parseSeriesMetadata(meta, dataset);

    results.push({ mnemonic, metadata: parsedMeta, data: points });
  }

  if (results.length === 0) {
    console.warn(`  [WARN] No series parsed for dataset "${dataset}"`);
  }

  return results;
}

/**
 * Fetch a single time series by mnemonic.
 * The single-series endpoint uses the same nested structure as dataset entries.
 */
export async function fetchTimeSeries(
  mnemonic: string,
  since?: string
): Promise<SeriesResult> {
  const url = buildUrl("/series/timeseries", {
    mnemonic,
    ...(since ? { start_date: since } : {}),
  });

  const raw = await apiFetch(url);

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { mnemonic, data: [] };
  }

  const obj = raw as Record<string, unknown>;

  // Try the same nested structure as dataset entries
  const innerTs = (obj.timeseries ?? {}) as Record<string, unknown>;
  let points = parseAggregation(innerTs.aggregation);

  // Fallback: maybe aggregation is at the top level
  if (points.length === 0) {
    points = parseAggregation(obj.aggregation);
  }

  const meta = (obj.metadata ?? {}) as Record<string, unknown>;

  return {
    mnemonic,
    metadata: parseSeriesMetadata(meta, inferDataset(mnemonic)),
    data: points,
  };
}

/**
 * Search OFR metadata.
 * Note: this endpoint currently returns [] for all queries; results may be empty.
 */
export async function searchMetadata(query: string): Promise<MnemonicMeta[]> {
  const url = buildUrl("/metadata/search", { query });
  const raw = await apiFetch(url);

  if (!Array.isArray(raw)) return [];

  return raw
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      mnemonic: String(item.mnemonic ?? item.id ?? ""),
      dataset: String(item.dataset ?? ""),
      category: (item.category ?? undefined) as string | undefined,
      description: (item.description ?? item.name ?? undefined) as string | undefined,
      frequency: (item.frequency ?? undefined) as string | undefined,
    }))
    .filter((m) => m.mnemonic !== "");
}
