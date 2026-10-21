const SENSITIVE_KEY = /token|secret|password|authorization|cookie|credential|ssh|key/i;

/** Deep-redact keys that look sensitive before args hit the audit log. */
export function sanitizeForAudit(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitizeForAudit);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[redacted]' : sanitizeForAudit(v),
      ]),
    );
  }
  return value;
}
