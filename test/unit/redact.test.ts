import { describe, expect, it } from 'vitest';
import { maskUsername, redactDeep, redactString, truncateForError } from '../../src/core/redact.js';
import { createLogger } from '../../src/core/logger.js';

describe('redactString', () => {
  it('redacts inline password, token, and api key assignments', () => {
    const input = 'login failed password=hunter2 token: abc123 api_key=XYZ';
    const output = redactString(input);
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('abc123');
    expect(output).not.toContain('XYZ');
    expect(output).toContain('[REDACTED]');
  });

  it('redacts credentials embedded in URLs', () => {
    const output = redactString('connect smtp://alice:supersecret@mail.example.com:465');
    expect(output).not.toContain('supersecret');
    expect(output).toContain('alice:[REDACTED]@mail.example.com');
  });

  it('redacts authorization headers', () => {
    const output = redactString('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature');
    expect(output).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(output).toContain('Bearer [REDACTED]');
  });
});

describe('redactDeep', () => {
  it('redacts secret-looking keys at any depth', () => {
    const output = redactDeep({
      account: {
        id: 'demo-a',
        password: 'hunter2',
        nested: { access_token: 'secret-token', apiKey: 'key-123', safe: 'visible' },
      },
    });
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('key-123');
    expect(serialized).toContain('visible');
  });

  it('handles errors, buffers, circular references, and deep nesting', () => {
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    const output = redactDeep({
      error: new Error('password=oops'),
      buffer: Buffer.from('data'),
      circular,
    }) as Record<string, unknown>;
    expect(JSON.stringify(output)).not.toContain('oops');
    expect(output['buffer']).toBe('[Buffer 4 bytes]');
    expect(JSON.stringify(output['circular'])).toContain('[CIRCULAR]');
  });

  it('truncates values nested too deeply', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 'bottom' } } } } } } } };
    expect(JSON.stringify(redactDeep(deep))).toContain('[TRUNCATED]');
  });
});

describe('maskUsername and truncateForError', () => {
  it('masks the local part of usernames and email addresses', () => {
    expect(maskUsername('alex@example.com')).toBe('a***@example.com');
    expect(maskUsername('alexander')).toBe('al***');
    expect(maskUsername('ab')).toBe('***');
    expect(maskUsername('')).toBe('');
  });

  it('redacts and truncates long error messages', () => {
    const message = `password=hunter2 ${'x'.repeat(3_000)}`;
    const output = truncateForError(message);
    expect(output.length).toBeLessThanOrEqual(2_001);
    expect(output).not.toContain('hunter2');
  });
});

describe('createLogger', () => {
  it('writes structured JSON through the sink and redacts secrets', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    logger.info('login_attempt', { username: 'alex@example.com', password: 'hunter2', safe: 1 });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(entry['event']).toBe('login_attempt');
    expect(entry['password']).toBe('[REDACTED]');
    expect(JSON.stringify(entry)).not.toContain('hunter2');
  });

  it('respects the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'error', sink: (line) => lines.push(line) });
    logger.info('ignored');
    logger.error('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });
});
