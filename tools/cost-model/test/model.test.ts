import { describe, expect, it } from 'vitest';
import { computeCost, exampleProfile } from '../src/model.js';

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
});
