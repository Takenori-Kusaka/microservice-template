import { describe, expect, it } from 'vitest';
import { REDACTED, createRedactor, redact } from '../src/redaction.js';

describe('redaction', () => {
  it('masks sensitive keys case-insensitively', () => {
    const out = redact({ Password: 'x', nested: { Authorization: 'Bearer abc', ok: 1 } }) as Record<
      string,
      unknown
    >;
    expect(out['Password']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['Authorization']).toBe(REDACTED);
    expect((out['nested'] as Record<string, unknown>)['ok']).toBe(1);
  });

  it('masks JWT, AWS access key and e-mail patterns inside free text', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redact(`token=${jwt} key=AKIAIOSFODNN7EXAMPLE mail=a.b@example.com`) as string;
    expect(out).not.toContain(jwt);
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(out).not.toContain('a.b@example.com');
  });

  it('handles circular structures and errors', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    const out = redact(obj) as Record<string, unknown>;
    expect(out['self']).toBe('[CIRCULAR]');
    const err = redact(new Error('contact a@b.io')) as { message: string };
    expect(err.message).toContain(REDACTED);
  });

  it('supports extra keys', () => {
    const r = createRedactor(['tenantSecretCode']);
    expect((r({ tenantSecretCode: '1' }) as Record<string, unknown>)['tenantSecretCode']).toBe(
      REDACTED,
    );
  });
});
