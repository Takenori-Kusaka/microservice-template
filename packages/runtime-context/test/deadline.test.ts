import { describe, expect, it, vi } from 'vitest';
import { Deadline, DeadlineExceededError, assertBudget } from '../src/deadline.js';

describe('Deadline', () => {
  it('derives from lambda context with a safety margin', () => {
    const d = Deadline.fromLambdaContext({ getRemainingTimeInMillis: () => 3000 }, 500);
    expect(d.remainingMs()).toBeLessThanOrEqual(2500);
    expect(d.remainingMs()).toBeGreaterThan(2400);
  });

  it('picks the earliest deadline', () => {
    const a = Deadline.fromNow(1000);
    const b = Deadline.fromNow(5000);
    expect(Deadline.earliest(b, undefined, a)).toBe(a);
  });

  it('round-trips through header value', () => {
    const d = Deadline.fromNow(1234);
    expect(Deadline.fromHeaderValue(d.toHeaderValue())?.deadlineAtMs).toBe(d.deadlineAtMs);
    expect(Deadline.fromHeaderValue('garbage')).toBeUndefined();
  });

  it('child budget reserves time and caps', () => {
    const d = Deadline.fromNow(2000);
    const child = d.child({ reserveMs: 500, maxMs: 1000 });
    expect(child.remainingMs()).toBeLessThanOrEqual(1000);
  });

  it('assertBudget throws when expired', () => {
    vi.useFakeTimers();
    const d = Deadline.fromNow(10);
    vi.advanceTimersByTime(20);
    expect(() => assertBudget(d, 'dynamodb.put')).toThrow(DeadlineExceededError);
    vi.useRealTimers();
  });
});
