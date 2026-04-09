/**
 * OFR Hedge Fund Monitor API client.
 *
 * The API lives at https://data.financialresearch.gov/hf/v1/
 * No authentication required. Data updates at most once per day.
 *
 * Because this environment cannot reach the API to probe response formats,
 * the parser is defensive: it tries multiple known shapes, logs what it sees,
 * and never crashes on unexpected structure — it returns empty data and warns.
 *
 * Run `npm run ingest -- --debug` on first use to see the raw response shapes
 * and confirm that parsing worked correctly.
 */

const BASE_URL = "https://data.financialresearch.gov/hf/v1";
const DATASETS = ["fpf", "tff", "scoos", "ficc"] as const;
export type Dataset = (typeof DATASETS)[number];

// ─── Public types ────────────────────────────────────────────────────────────

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

// ─── Internal config ─────────────────────────────────────────────────────────

let debugMode = false;

export function setDebugMode(on: boolean): void {
  debugMode = on;
}

// ─── Date normalisation ───────────────────────────────────────────────────────

/**
 * Convert whatever the API gives us into YYYY-MM-DD.
 * Handles:
 *   - Unix ms timestamps (numbers or numeric strings > 1e10)
 *   - Unix s  timestamps (numbers < 1e10)
 *   - ISO strings with time component ("2023-01-01T00:00:00Z")
 *   - Plain "YYYY-MM-DD"
 *   - "MM/DD/YYYY"
 */
export function normalizeDate(raw: string | number): string {
  if (typeof raw === "number" || /^\d{10,13}$/.test(String(raw))) {
    const n = Number(raw);
    const ms = n > 1e10 ? n : n * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  const s = String(raw).trim();
  // ISO with time
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  // Plain ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // MM/DD/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split("/");
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  // Fall back: try Date constructor
  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  throw new Error(`Cannot normalise date: ${JSON.stringify(raw)}`);
}

// ─── Response format detection ────────────────────────────────────────────────

type RawAny = unknown;

/**
 * Detect format and extract [date, value] pairs from an unknown response body.
 * Returns null if the format is completely unrecognised.
 */
function extractPoints(raw: RawAny): TimeSeriesPoint[] | null {
  if (Array.isArray(raw)) {
    // Highcharts flat array: [[timestamp_ms, value], ...]
    if (raw.length > 0 && Array.isArray(raw[0]) && raw[0].length === 2) {
      return raw.map(([d, v]: [string | number, number | null]) => ({
        date: normalizeDate(d),
        value: v ?? null,
      }));
    }
    // Array of {date, value} objects
    if (
      raw.length > 0 &&
      typeof raw[0] === "object" &&
      raw[0] !== null &&
      ("date" in raw[0] || "Date" in raw[0])
    ) {
      return raw.map((pt: Record<string, unknown>) => ({
        date: normalizeDate((pt.date ?? pt.Date ?? pt.period ?? "") as string | number),
        value: (pt.value ?? pt.Value ?? pt.obs_value ?? null) as number | null,
      }));
    }
    return null;
  }

  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  // Parallel arrays: {dates: [...], values: [...]}
  if (Array.isArray(obj.dates) && Array.isArray(obj.values)) {
    return (obj.dates as (string | number)[]).map((d, i) => ({
      date: normalizeDate(d),
      value: ((obj.values as (number | null)[])[i] ?? null),
    }));
  }
  if (Array.isArray(obj.date) && Array.isArray(obj.value)) {
    return (obj.date as (string | number)[]).map((d, i) => ({
      date: normalizeDate(d),
      value: ((obj.value as (number | null)[])[i] ?? null),
    }));
  }

  // Nested data array: {data: [...]}
  if (Array.isArray(obj.data)) {
    return extractPoints(obj.data);
  }

  // Highcharts wrapper: {series: [{name, data: [[ts, val]]}]}
  if (Array.isArray(obj.series)) {
    const first = (obj.series as RawAny[])[0];
    if (first && typeof first === "object" && Array.isArray((first as Record<string, unknown>).data)) {
      return extractPoints((first as Record<string, unknown>).data);
    }
  }

  return null;
}

/**
 * Extract an array of {mnemonic, data[]} from a dataset response.
 * A dataset response may be:
 *   - An array of series objects
 *   - An object keyed by mnemonic
 *   - A Highcharts multi-series array
 */
function extractSeriesArray(raw: RawAny, dataset: string): SeriesResult[] {
  if (debugMode) {
    const shape =
      Array.isArray(raw)
        ? `Array[${(raw as RawAny[]).length}]`
        : typeof raw === "object" && raw !== null
        ? `Object{${Object.keys(raw as object).slice(0, 10).join(",")}}`
        : typeof raw;
    console.log(`  [DEBUG] /series/dataset?dataset=${dataset} shape: ${shape}`);
    if (Array.isArray(raw) && (raw as RawAny[]).length > 0) {
      const first = (raw as RawAny[])[0];
      console.log(`  [DEBUG] First element keys: ${typeof first === "object" && first ? Object.keys(first as object).join(",") : typeof first}`);
    }
  }

  const results: SeriesResult[] = [];

  if (Array.isArray(raw)) {
    for (const item of raw as RawAny[]) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;

      const mnemonic =
        (obj.mnemonic ?? obj.Mnemonic ?? obj.name ?? obj.id ?? obj.series_id) as string | undefined;
      if (!mnemonic) continue;

      const points = extractPoints(obj.data ?? obj.observations ?? item);
      results.push({
        mnemonic: String(mnemonic),
        metadata: extractMeta(obj, dataset),
        data: points ?? [],
      });
    }
    return results;
  }

  if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;

    // Object keyed by mnemonic: {"FPF-XXX": {data: [...]}, ...}
    for (const [key, val] of Object.entries(obj)) {
      if (key === "metadata" || key === "meta") continue;
      const points = extractPoints(val);
      if (points !== null) {
        results.push({ mnemonic: key, data: points });
      }
    }
    if (results.length > 0) return results;

    // Maybe it's a single series wrapped in an object
    const points = extractPoints(raw);
    if (points !== null) {
      const mnemonic = (obj.mnemonic ?? obj.name ?? dataset) as string;
      results.push({ mnemonic: String(mnemonic), metadata: extractMeta(obj, dataset), data: points });
    }
  }

  return results;
}

/** Extract whatever metadata fields exist on a raw series object. */
function extractMeta(
  obj: Record<string, unknown>,
  dataset: string
): Partial<MnemonicMeta> {
  return {
    dataset: (obj.dataset ?? obj.source ?? dataset) as string,
    category: (obj.category ?? obj.Category ?? obj.group ?? undefined) as string | undefined,
    description: (obj.description ?? obj.Description ?? obj.label ?? obj.name ?? undefined) as string | undefined,
    frequency: (obj.frequency ?? obj.Frequency ?? obj.periodicity ?? undefined) as string | undefined,
  };
}

// ─── Rate-limiting + retry fetch ─────────────────────────────────────────────

const DELAY_MS = 500; // between requests — polite
const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _lastRequestTime = 0;

async function apiFetch(url: string): Promise<unknown> {
  // Throttle to one request per DELAY_MS
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
        const preview = JSON.stringify(body).slice(0, 300);
        console.log(`  [DEBUG] Response (first 300 chars): ${preview}`);
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

    throw new Error(`OFR API error: HTTP ${resp.status} for ${url}`);
  }
}

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v);
  }
  return url.toString();
}

// ─── Public API functions ─────────────────────────────────────────────────────

/**
 * Fetch the full mnemonics catalogue from /metadata/mnemonics.
 */
export async function fetchMnemonics(): Promise<MnemonicMeta[]> {
  const raw = await apiFetch(`${BASE_URL}/metadata/mnemonics`);

  if (debugMode) {
    const shape = Array.isArray(raw)
      ? `Array[${(raw as RawAny[]).length}]`
      : typeof raw === "object" && raw !== null
      ? `Object{${Object.keys(raw as object).slice(0, 10).join(",")}}`
      : typeof raw;
    console.log(`  [DEBUG] /metadata/mnemonics shape: ${shape}`);
    if (Array.isArray(raw) && (raw as RawAny[]).length > 0) {
      console.log(`  [DEBUG] First mnemonic entry: ${JSON.stringify((raw as RawAny[])[0])}`);
    }
  }

  const items: RawAny[] = Array.isArray(raw)
    ? (raw as RawAny[])
    : Array.isArray((raw as Record<string, unknown>).data)
    ? ((raw as Record<string, unknown>).data as RawAny[])
    : Array.isArray((raw as Record<string, unknown>).mnemonics)
    ? ((raw as Record<string, unknown>).mnemonics as RawAny[])
    : [];

  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      mnemonic: String(item.mnemonic ?? item.Mnemonic ?? item.id ?? item.series_id ?? ""),
      dataset: String(item.dataset ?? item.source ?? item.group ?? ""),
      category: (item.category ?? item.Category ?? undefined) as string | undefined,
      description: (item.description ?? item.Description ?? item.label ?? undefined) as string | undefined,
      frequency: (item.frequency ?? item.Frequency ?? item.periodicity ?? undefined) as string | undefined,
    }))
    .filter((m) => m.mnemonic !== "");
}

/**
 * Fetch all series for a dataset.
 * Passes start_date when `since` is provided (incremental updates).
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
  const series = extractSeriesArray(raw, dataset);

  if (series.length === 0) {
    console.warn(
      `  [WARN] No series parsed for dataset "${dataset}". Run with --debug to inspect the raw response.`
    );
  }

  return series;
}

/**
 * Fetch a single time series by mnemonic.
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

  if (debugMode) {
    const shape =
      typeof raw === "object" && raw !== null
        ? `Object{${Object.keys(raw as object).slice(0, 10).join(",")}}`
        : typeof raw;
    console.log(`  [DEBUG] /series/timeseries?mnemonic=${mnemonic} shape: ${shape}`);
  }

  const points = extractPoints(raw);

  if (points === null) {
    console.warn(
      `  [WARN] Could not parse timeseries for "${mnemonic}". Run with --debug to inspect the raw response.`
    );
    return { mnemonic, data: [] };
  }

  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    mnemonic,
    metadata: extractMeta(obj, ""),
    data: points,
  };
}

/**
 * Search OFR metadata.
 */
export async function searchMetadata(query: string): Promise<MnemonicMeta[]> {
  const url = buildUrl("/metadata/search", { query });
  const raw = await apiFetch(url);

  const items: RawAny[] = Array.isArray(raw)
    ? (raw as RawAny[])
    : Array.isArray((raw as Record<string, unknown>).results)
    ? ((raw as Record<string, unknown>).results as RawAny[])
    : Array.isArray((raw as Record<string, unknown>).data)
    ? ((raw as Record<string, unknown>).data as RawAny[])
    : [];

  return items
    .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
    .map((item) => ({
      mnemonic: String(item.mnemonic ?? item.id ?? item.series_id ?? ""),
      dataset: String(item.dataset ?? item.source ?? ""),
      category: (item.category ?? undefined) as string | undefined,
      description: (item.description ?? item.label ?? undefined) as string | undefined,
      frequency: (item.frequency ?? item.periodicity ?? undefined) as string | undefined,
    }))
    .filter((m) => m.mnemonic !== "");
}
