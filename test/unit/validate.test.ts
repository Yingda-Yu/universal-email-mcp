import { describe, expect, it } from 'vitest';
import { EmailMcpError } from '../../src/core/errors.js';
import {
  assertNoControlChars,
  assertResolvedAddressesAllowed,
  assertSafeRemoteHost,
  isLoopbackHost,
  isPrivateIp,
  isValidEmailAddress,
  normalizeAddressList,
  parseBooleanEnv,
  parseMailbox,
  validateBodySizes,
  validateFolderPath,
  validateIsoDate,
  validateMessageIdHeader,
  validateReferences,
  validateSearchQuery,
  validateSubject,
} from '../../src/core/validate.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EmailMcpError);
    expect((error as EmailMcpError).code).toBe(code);
    return;
  }
  throw new Error(`Expected EmailMcpError with code ${code}`);
}

describe('email address validation', () => {
  it('accepts ordinary and quoted display-name addresses', () => {
    expect(isValidEmailAddress('alex@example.com')).toBe(true);
    expect(isValidEmailAddress('first.last+tag@sub.example.co.uk')).toBe(true);
    expect(parseMailbox('Alex Example <alex@example.com>')).toEqual({
      name: 'Alex Example',
      address: 'alex@example.com',
    });
    expect(parseMailbox('alex@example.com')).toEqual({ address: 'alex@example.com' });
  });

  it.each([
    '',
    'alex',
    '@example.com',
    'alex@',
    'alex@localhost',
    'alex@@example.com',
    'alex@example..com',
    '.alex@example.com',
    'alex.@example.com',
    'alex doe@example.com',
  ])('rejects malformed address %j', (value) => {
    expect(isValidEmailAddress(value)).toBe(false);
  });

  it('blocks header injection in addresses', () => {
    expectCode(() => parseMailbox('alex@example.com\r\nBcc: victim@example.com'), 'HEADER_INJECTION_BLOCKED');
    expectCode(() => parseMailbox('alex@example.com\nBcc: victim@example.com'), 'HEADER_INJECTION_BLOCKED');
  });

  it('normalizes lists and removes duplicates case-insensitively', () => {
    expect(
      normalizeAddressList(
        ['Alex <alex@example.com>', 'ALEX@example.com', 'blair@example.org'],
        'to',
      ),
    ).toEqual([
      { name: 'Alex', address: 'alex@example.com' },
      { address: 'blair@example.org' },
    ]);
  });

  it('rejects control characters', () => {
    expectCode(() => assertNoControlChars('hello\u0007world', 'field'), 'INVALID_ARGUMENT');
    expectCode(() => assertNoControlChars('hello\rworld', 'field'), 'HEADER_INJECTION_BLOCKED');
  });
});

describe('subject, folder, query, and body validation', () => {
  it('rejects CRLF in subjects', () => {
    expectCode(() => validateSubject('Hello\r\nBcc: victim@example.com'), 'HEADER_INJECTION_BLOCKED');
  });

  it('trims subjects and rejects empty or oversized values', () => {
    expect(validateSubject('  Hello  ')).toBe('Hello');
    expectCode(() => validateSubject('   '), 'INVALID_ARGUMENT');
    expectCode(() => validateSubject('x'.repeat(999)), 'INVALID_ARGUMENT');
  });

  it('rejects folder traversal and control characters', () => {
    expect(validateFolderPath('INBOX')).toBe('INBOX');
    expect(validateFolderPath('Archive/2026')).toBe('Archive/2026');
    expectCode(() => validateFolderPath('..'), 'INVALID_ARGUMENT');
    expectCode(() => validateFolderPath('INBOX/../Other'), 'INVALID_ARGUMENT');
    expectCode(() => validateFolderPath('INBOX\u0000'), 'HEADER_INJECTION_BLOCKED');
  });

  it('validates search queries', () => {
    expect(validateSearchQuery(' invoice ')).toBe('invoice');
    expectCode(() => validateSearchQuery(''), 'INVALID_ARGUMENT');
    expectCode(() => validateSearchQuery('x'.repeat(513)), 'INVALID_ARGUMENT');
  });

  it('enforces body size limits', () => {
    expect(() => validateBodySizes('hello', '<p>hello</p>')).not.toThrow();
    expectCode(() => validateBodySizes('x'.repeat(100_001), null), 'SIZE_LIMIT_EXCEEDED');
    expectCode(() => validateBodySizes(null, 'x'.repeat(200_001)), 'SIZE_LIMIT_EXCEEDED');
  });
});

describe('message id and date validation', () => {
  it('requires angle-bracketed Message-ID values', () => {
    expect(validateMessageIdHeader('<abc@example.com>')).toBe('<abc@example.com>');
    expectCode(() => validateMessageIdHeader('abc@example.com'), 'INVALID_ARGUMENT');
    expectCode(() => validateMessageIdHeader('<a@example.com>\r\nBcc: x@example.com'), 'HEADER_INJECTION_BLOCKED');
  });

  it('validates References headers', () => {
    expect(validateReferences(['<a@example.com>', '<b@example.com>'])).toEqual([
      '<a@example.com>',
      '<b@example.com>',
    ]);
    expectCode(() => validateReferences(['not-a-message-id']), 'INVALID_ARGUMENT');
  });

  it('validates calendar dates strictly', () => {
    expect(validateIsoDate('2026-11-11', 'since').toISOString()).toBe('2026-11-11T00:00:00.000Z');
    expectCode(() => validateIsoDate('2026-02-30', 'since'), 'INVALID_ARGUMENT');
    expectCode(() => validateIsoDate('11/11/2026', 'since'), 'INVALID_ARGUMENT');
  });
});

describe('environment and network safety', () => {
  it('parses boolean environment values strictly', () => {
    expect(parseBooleanEnv(undefined, false)).toBe(false);
    expect(parseBooleanEnv('true', false)).toBe(true);
    expect(parseBooleanEnv('1', false)).toBe(true);
    expect(parseBooleanEnv('false', true)).toBe(false);
    expectCode(() => parseBooleanEnv('yes', false), 'CONFIG_INVALID');
  });

  it('recognizes loopback and private addresses', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('imap.example.com')).toBe(false);
    expect(isPrivateIp('10.0.0.1')).toBe(true);
    expect(isPrivateIp('172.16.4.2')).toBe(true);
    expect(isPrivateIp('192.168.1.1')).toBe(true);
    expect(isPrivateIp('169.254.169.254')).toBe(true);
    expect(isPrivateIp('203.0.113.10')).toBe(false);
    expect(isPrivateIp('8.8.8.8')).toBe(false);
  });

  it('rejects schemes, ports, and metadata endpoints in mail hosts', () => {
    expect(assertSafeRemoteHost('imap.example.com', false)).toBe('imap.example.com');
    expectCode(() => assertSafeRemoteHost('https://imap.example.com', false), 'CONFIG_INVALID');
    expectCode(() => assertSafeRemoteHost('imap.example.com:993', false), 'CONFIG_INVALID');
    expectCode(() => assertSafeRemoteHost('169.254.169.254', false), 'SECURITY_BLOCKED');
    expectCode(() => assertSafeRemoteHost('metadata.google.internal', false), 'SECURITY_BLOCKED');
    expectCode(() => assertSafeRemoteHost('127.0.0.1', false), 'SECURITY_BLOCKED');
    expect(assertSafeRemoteHost('127.0.0.1', true)).toBe('127.0.0.1');
  });

  it('blocks private resolved addresses unless explicitly allowed', () => {
    expectCode(() => assertResolvedAddressesAllowed(['10.1.2.3'], false), 'SECURITY_BLOCKED');
    expect(() => assertResolvedAddressesAllowed(['10.1.2.3'], true)).not.toThrow();
    expect(() => assertResolvedAddressesAllowed(['203.0.113.10'], false)).not.toThrow();
  });
});
