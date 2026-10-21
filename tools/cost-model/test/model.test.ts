import { describe, expect, it } from 'vitest';
import { albVsHttpApiBreakEven, computeCost, exampleProfile } from '../src/model.js';

describe('cost model', () => {
  it('attributes request-driven cost proportionally to tier activity', () => {
    const report = computeCost(exampleProfile);
    expect(report.total).toBeGreaterThan(0);
    const sum = Object.values(report.perTier).reduce((s, t) => s + t.usd, 0);
    expect(Math.abs(sum - report.total)).toBeLessThan(1e-6);
    expect(report.perTier['enterprise']!.perTenant).toBeGreaterThan(
      report.perTier['standard']!.perTenant,
    );
  });

  it('is linear in requests for request-driven components', () => {
    const a = computeCost({ ...exampleProfile, sharedMonthlyUsd: 0 });
    const doubled = computeCost({
      ...exampleProfile,
      sharedMonthlyUsd: 0,
      tiers: Object.fromEntries(
        Object.entries(exampleProfile.tiers).map(([k, v]) => [
          k,
          { ...v, apiRequestsPerTenant: v.apiRequestsPerTenant * 2 },
        ]),
      ) as typeof exampleProfile.tiers,
    });
    const requestDriven = (r: typeof a) =>
      r.lines.filter((l) => l.driver === 'requests').reduce((s, l) => s + l.usd, 0);
    expect(requestDriven(doubled) / requestDriven(a)).toBeCloseTo(2, 5);
  });

  it('computes the ALB vs HTTP API break-even from verified Tokyo prices (M-03)', () => {
    const be = albVsHttpApiBreakEven();
    // 0.0243 * 730 + 0.008 * 730 = 23.579 USD/month; / 1.29e-6 USD per request = 18.28M
    expect(be.albFixedUsdPerMonth).toBeCloseTo(23.579, 3);
    expect(be.breakEvenRequestsPerMonth / 1e6).toBeCloseTo(18.28, 1);
    expect(be.breakEvenAverageRps).toBeGreaterThan(6.5);
    expect(be.breakEvenAverageRps).toBeLessThan(7.5);
  });
});
