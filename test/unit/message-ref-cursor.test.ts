import { describe, expect, it } from 'vitest';
import { decodeOffsetCursor, decodeUidCursor, encodeOffsetCursor, encodeUidCursor } from '../../src/core/cursor.js';
import { decodeMessageRef, encodeMessageRef } from '../../src/core/message-ref.js';
import { EmailMcpError } from '../../src/core/errors.js';
import { validateOutgoingMessage } from '../../src/core/outgoing.js';

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

describe('message references', () => {
  it('round-trips folder names, including unicode and slashes', () => {
    const ref = encodeMessageRef('imap1', 'Archive/2026/发票', '12345', 42);
    expect(ref.startsWith('imap1.')).toBe(true);
    expect(decodeMessageRef(ref)).toEqual({
      kind: 'imap1',
      folder: 'Archive/2026/发票',
      uidValidity: '12345',
      uid: 42,
    });
  });

  it('rejects a reference from another provider kind', () => {
    const ref = encodeMessageRef('mock1', 'INBOX', '1', 7);
    expectCode(() => decodeMessageRef(ref, 'imap1'), 'INVALID_ARGUMENT');
  });

  it('rejects tampered or malformed references', () => {
    expectCode(() => decodeMessageRef('imap1.not-base64!.1.1'), 'INVALID_ARGUMENT');
    expectCode(() => decodeMessageRef('imap1.*.1.1'), 'INVALID_ARGUMENT');
    expectCode(() => decodeMessageRef('garbage'), 'INVALID_ARGUMENT');
    expectCode(() => decodeMessageRef(''), 'INVALID_ARGUMENT');
    expectCode(() => encodeMessageRef('mock1', 'INBOX', '1', 0), 'INVALID_ARGUMENT');
  });
});

describe('pagination cursors', () => {
  it('round-trips offset cursors', () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
  });

  it('round-trips UID cursors', () => {
    const cursor = encodeUidCursor(987);
    expect(decodeUidCursor(cursor)).toBe(987);
  });

  it('rejects invalid cursor payloads', () => {
    expectCode(() => decodeOffsetCursor(encodeUidCursor(5)), 'INVALID_ARGUMENT');
    expectCode(() => decodeUidCursor(encodeOffsetCursor(5)), 'INVALID_ARGUMENT');
    expectCode(() => decodeOffsetCursor('not-a-cursor'), 'INVALID_ARGUMENT');
    expectCode(() => decodeOffsetCursor(Buffer.from('{"v":2,"o":0}').toString('base64url')), 'INVALID_ARGUMENT');
  });
});

describe('validateOutgoingMessage', () => {
  it('deduplicates recipients across to, cc, and bcc', () => {
    const validated = validateOutgoingMessage({
      to: [{ address: 'alex@example.com' }, { address: 'ALEX@example.com' }],
      cc: [{ address: 'alex@example.com' }, { address: 'blair@example.org' }],
      bcc: [{ address: 'blair@example.org' }, { address: 'casey@example.net' }],
      subject: 'Hello',
      text: 'Body',
      html: null,
      inReplyTo: null,
      references: [],
    });
    expect(validated.to).toEqual(['alex@example.com']);
    expect(validated.cc).toEqual(['blair@example.org']);
    expect(validated.bcc).toEqual(['casey@example.net']);
  });

  it('requires a recipient and a body', () => {
    expectCode(
      () =>
        validateOutgoingMessage({
          to: [],
          cc: [],
          bcc: [],
          subject: 'Hello',
          text: 'Body',
          html: null,
          inReplyTo: null,
          references: [],
        }),
      'INVALID_ARGUMENT',
    );
    expectCode(
      () =>
        validateOutgoingMessage({
          to: [{ address: 'alex@example.com' }],
          cc: [],
          bcc: [],
          subject: 'Hello',
          text: null,
          html: '   ',
          inReplyTo: null,
          references: [],
        }),
      'INVALID_ARGUMENT',
    );
  });

  it('rejects header injection through the subject', () => {
    expectCode(
      () =>
        validateOutgoingMessage({
          to: [{ address: 'alex@example.com' }],
          cc: [],
          bcc: [],
          subject: 'Hello\r\nBcc: victim@example.com',
          text: 'Body',
          html: null,
          inReplyTo: null,
          references: [],
        }),
      'HEADER_INJECTION_BLOCKED',
    );
  });
});
