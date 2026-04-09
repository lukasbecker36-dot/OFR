#!/usr/bin/env node
/**
 * Diagnostic script — hits each OFR endpoint and dumps the raw response
 * so we can see the actual JSON structure and fix the parser.
 *
 * Run via: npm run diagnose
 */

const BASE_URL = "https://data.financialresearch.gov/hf/v1";
const PREVIEW_LEN = 3000;

async function hit(label: string, url: string): Promise<void> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`${label}`);
  console.log(`URL: ${url}`);
  console.log("=".repeat(70));

  const resp = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "ofr-diagnose/1.0" },
  });

  console.log(`Status: ${resp.status} ${resp.statusText}`);
  console.log(`Content-Type: ${resp.headers.get("content-type")}`);

  const text = await resp.text();
  console.log(`Body length: ${text.length} chars`);
  console.log(`\nFirst ${PREVIEW_LEN} chars:`);
  console.log(text.slice(0, PREVIEW_LEN));

  // Also try to parse and show structure
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      console.log(`\n→ Top level: Array[${json.length}]`);
      if (json.length > 0) {
        console.log(`→ First element keys: ${Object.keys(json[0] ?? {}).join(", ")}`);
        console.log(`→ First element: ${JSON.stringify(json[0]).slice(0, 500)}`);
        if (json.length > 1) {
          console.log(`→ Second element: ${JSON.stringify(json[1]).slice(0, 500)}`);
        }
      }
    } else if (json && typeof json === "object") {
      console.log(`\n→ Top level: Object`);
      console.log(`→ Keys: ${Object.keys(json).join(", ")}`);
      for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
        if (Array.isArray(v)) {
          console.log(`→ json.${k} = Array[${v.length}]`);
          if (v.length > 0) {
            console.log(`   First element: ${JSON.stringify(v[0]).slice(0, 300)}`);
          }
        } else {
          console.log(`→ json.${k} = ${JSON.stringify(v).slice(0, 200)}`);
        }
      }
    }
  } catch {
    console.log("→ Response is not valid JSON");
  }
}

async function main() {
  console.log("OFR API Diagnostic\n");

  await hit(
    "1. Mnemonic metadata",
    `${BASE_URL}/metadata/mnemonics`
  );

  await hit(
    "2. FPF dataset (Form PF)",
    `${BASE_URL}/series/dataset?dataset=fpf`
  );

  await hit(
    "3. Single timeseries (FPF leverage ratio — guessing mnemonic)",
    `${BASE_URL}/series/timeseries?mnemonic=FPF-ALLQHF_LEVERAGERATIO_AVERAGE`
  );

  await hit(
    "4. Metadata search",
    `${BASE_URL}/metadata/search?query=leverage`
  );
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
