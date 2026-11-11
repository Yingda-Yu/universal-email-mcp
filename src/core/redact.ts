const SECRET_KEY_PATTERN =
  /(pass(word|wd)?|secret|token|authorization|cookie|credential|api[_-]?key|private[_-]?key|client[_-]?secret)/i;

const REDACTED = '[REDACTED]';

export function redactString(input: string): string {
  return input
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/(\/\/[^/\s:@]+):([^/\s@]+)@/g, `$1:${REDACTED}@`)
    .replace(
      /((?:password|passwd|pass|token|secret|api[_-]?key)\s*[=:]\s*)([^\s,;]+)/gi,
      `$1${REDACTED}`,
    )
    .replace(
      /\b(authorization\s*:\s*)([^\r\n]+)/gi,
      (_match: string, prefix: string, value: string) =>
        `${prefix}${/\[REDACTED\]/.test(value) ? value : REDACTED}`,
    );
}

/**
 * Deeply redacts secret-looking keys and credential patterns. Used for logs,
 * errors, and any diagnostic payload. Never serialize raw config directly.
 */
export function redactDeep(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) {
    return '[TRUNCATED]';
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack),
    };
  }
  if (Buffer.isBuffer(value)) {
    return `[Buffer ${value.length} bytes]`;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => redactDeep(item, depth + 1, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactDeep(item, depth + 1, seen);
    }
    return output;
  }
  return '[UNSERIALIZABLE]';
}

export function maskUsername(username: string): string {
  const trimmed = username.trim();
  if (trimmed.length === 0) {
    return '';
  }
  const at = trimmed.lastIndexOf('@');
  if (at > 0) {
    return `${trimmed.slice(0, 1)}***${trimmed.slice(at)}`;
  }
  if (trimmed.length <= 2) {
    return '***';
  }
  return `${trimmed.slice(0, 2)}***`;
}

export function truncateForError(message: string, max = 2_000): string {
  const redacted = redactString(message);
  return redacted.length <= max ? redacted : `${redacted.slice(0, max)}…`;
}
