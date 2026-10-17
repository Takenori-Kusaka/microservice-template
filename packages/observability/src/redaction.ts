/**
 * PII / secret redaction for structured logs (guideline §14 標準実装: "PII maskingとfield
 * allowlistを共通loggerで実装する").
 *
 * Strategy: deny-list of well-known sensitive key names + value patterns. The list is
 * intentionally conservative; services may extend it via {@link createRedactor}.
 */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'apikey',
  'api_key',
  'x-api-key',
  'cookie',
  'set-cookie',
  'ssn',
  'creditcard',
  'cardnumber',
  'cvv',
  'email',
  'phone',
  'phonenumber',
  'address',
  'birthdate',
  'dateofbirth',
];

const VALUE_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: 'aws-access-key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'card', pattern: /\b(?:\d[ -]?){13,19}\b/g },
];

export const REDACTED = '[REDACTED]';

export interface Redactor {
  (value: unknown): unknown;
}

export function createRedactor(extraKeys: readonly string[] = [], maxDepth = 8): Redactor {
  const keys = new Set([...DEFAULT_SENSITIVE_KEYS, ...extraKeys].map((k) => k.toLowerCase()));

  const redactString = (s: string): string => {
    let out = s;
    for (const { pattern } of VALUE_PATTERNS) {
      out = out.replace(pattern, REDACTED);
    }
    return out;
  };

  const walk = (value: unknown, depth: number, seen: WeakSet<object>): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return redactString(value);
    if (typeof value !== 'object') return value;
    if (depth > maxDepth) return '[TRUNCATED]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    if (value instanceof Error) {
      return { name: value.name, message: redactString(value.message), stack: value.stack };
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v, depth + 1, seen));
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.has(k.toLowerCase()) ? REDACTED : walk(v, depth + 1, seen);
    }
    return out;
  };

  return (value: unknown) => walk(value, 0, new WeakSet());
}

export const redact: Redactor = createRedactor();
