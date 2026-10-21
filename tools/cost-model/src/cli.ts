#!/usr/bin/env node
/**
 * pnpm cost-model [--profile path/to/profile.json] [--check-prices]
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  albVsHttpApiBreakEven,
  computeCost,
  exampleProfile,
  type WorkloadProfile,
} from './model.js';
import { PRICES, stalePrices } from './prices.js';

function option(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.includes('--check-prices')) {
    const stale = stalePrices();
    for (const k of stale)
      console.log(
        `STALE  ${k}: ${PRICES[k].value} ${PRICES[k].unit} (verified ${PRICES[k].verifiedAt}, verified=${PRICES[k].verified}) ← ${PRICES[k].source}`,
      );
    console.log(
      stale.length === 0
        ? 'all prices verified within 90 days'
        : `${stale.length} price(s) need re-verification before use`,
    );
    process.exit(stale.length === 0 ? 0 : 1);
  }
  const profilePath = option('profile');
  const profile: WorkloadProfile = profilePath
    ? (JSON.parse(readFileSync(profilePath, 'utf8')) as WorkloadProfile)
    : exampleProfile;
  const report = computeCost(profile);
  const be = albVsHttpApiBreakEven();
  console.log(
    `ALB vs HTTP API break-even (M-03): ALB fixed ${be.albFixedUsdPerMonth.toFixed(2)} USD/month (730 h + 1 LCU) = ${(be.breakEvenRequestsPerMonth / 1e6).toFixed(1)}M requests/month = ${be.breakEvenAverageRps.toFixed(1)} RPS average`,
  );
  const fmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

  console.log('\nMonthly cost by component (USD)');
  for (const l of report.lines)
    console.log(`  ${l.component.padEnd(32)} ${fmt(l.usd).padStart(12)}   [${l.driver}]`);
  console.log(`  ${'TOTAL'.padEnd(32)} ${fmt(report.total).padStart(12)}`);
  console.log('\nPer tier');
  for (const [tier, t] of Object.entries(report.perTier)) {
    console.log(
      `  ${tier.padEnd(12)} tenants=${t.tenants}  usd=${fmt(t.usd)}  per-tenant=${fmt(t.perTenant)}  per-request=${t.perRequest.toExponential(2)}`,
    );
  }
  console.log(`\nBlended cost per API request: ${report.perRequest.toExponential(3)} USD`);
  const stale = stalePrices();
  if (stale.length > 0) {
    console.log(
      `\nWARNING: ${stale.length} price(s) are unverified or older than 90 days. Run --check-prices and update tools/cost-model/src/prices.ts with the source URL and date before quoting these numbers.`,
    );
  }
}
