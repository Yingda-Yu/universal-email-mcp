import { describe, expect, it } from 'vitest';
import {
  makeSnippet,
  parseRawMessage,
  sanitizeUntrustedHtml,
  stripHtmlToText,
} from '../../src/core/mime.js';
import { buildRawEmail } from '../helpers/raw-email.js';

describe('sanitizeUntrustedHtml', () => {
  it('removes scripts, event handlers, and dangerous URLs', () => {
    const html =
      '<p onclick="steal()">Hello</p><script>alert(1)</script><a href="javascript:alert(2)">link</a>';
    const sanitized = sanitizeUntrustedHtml(html);
    expect(sanitized).not.toContain('<script');
    expect(sanitized).not.toContain('onclick');
    expect(sanitized).not.toContain('javascript:');
    expect(sanitized).toContain('Hello');
  });

  it('removes iframes, forms, and embedded styles', () => {
    const html =
      '<style>body{display:none}</style><iframe src="https://evil.example"></iframe><form action="/x"><input></form><p>safe</p>';
    const sanitized = sanitizeUntrustedHtml(html);
    expect(sanitized).not.toContain('<style');
    expect(sanitized).not.toContain('<iframe');
    expect(sanitized).not.toContain('<form');
    expect(sanitized).toContain('<p>safe</p>');
  });

  it('strips HTML to readable text', () => {
    expect(stripHtmlToText('<p>Hello&nbsp;<strong>world</strong></p>')).toBe('Hello world');
  });

  it('builds snippets from text or HTML', () => {
    expect(makeSnippet('line one\nline two', null, 20)).toBe('line one line two');
    expect(makeSnippet(null, '<p>Fallback <b>snippet</b></p>', 20)).toBe('Fallback snippet');
    expect(makeSnippet('x'.repeat(400), null, 20)).toHaveLength(20);
  });
});

describe('parseRawMessage', () => {
  it('parses headers, bodies, attachments, and references', async () => {
    const raw = buildRawEmail({
      from: 'Blair Chen <blair@example.org>',
      to: ['alex@example.com', 'team@example.com'],
      cc: 'finance@example.com',
      subject: '第四季度发票 / Invoice INV-2041',
      date: 'Tue, 04 Nov 2026 10:00:00 +0000',
      messageId: '<invoice-2041@vendor.example>',
      inReplyTo: '<kickoff@example.org>',
      references: ['<kickoff@example.org>', '<agenda@example.org>'],
      text: 'Plain invoice body',
      html: '<p>Invoice <strong>INV-2041</strong></p><script>alert("x")</script>',
      attachments: [
        {
          filename: 'INV-2041.pdf',
          contentType: 'application/pdf',
          content: '%PDF-1.4 fake',
        },
      ],
    });

    const parsed = await parseRawMessage(raw, { maxBodyChars: 20_000 });
    expect(parsed.subject).toBe('第四季度发票 / Invoice INV-2041');
    expect(parsed.from).toEqual([{ name: 'Blair Chen', address: 'blair@example.org' }]);
    expect(parsed.to.map((address) => address.address)).toEqual([
      'alex@example.com',
      'team@example.com',
    ]);
    expect(parsed.cc[0]?.address).toBe('finance@example.com');
    expect(parsed.date?.toISOString()).toBe('2026-11-04T10:00:00.000Z');
    expect(parsed.messageIdHeader).toBe('<invoice-2041@vendor.example>');
    expect(parsed.inReplyTo).toBe('<kickoff@example.org>');
    expect(parsed.references).toEqual(['<kickoff@example.org>', '<agenda@example.org>']);
    expect(parsed.text).toContain('Plain invoice body');
    expect(parsed.html).toContain('INV-2041');
    expect(parsed.html).not.toContain('<script');
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe('INV-2041.pdf');
    expect(parsed.attachments[0]?.contentType).toBe('application/pdf');
    expect(parsed.warnings).toContain('html_sanitized');
    expect(parsed.truncated).toBe(false);
  });

  it('truncates bodies at the requested character limit', async () => {
    const raw = buildRawEmail({ text: 'x'.repeat(500) });
    const parsed = await parseRawMessage(raw, { maxBodyChars: 25 });
    expect(parsed.text).toHaveLength(25);
    expect(parsed.truncated).toBe(true);
    expect(parsed.warnings).toContain('body_truncated');
  });

  it('ignores invalid sender addresses and records a warning', async () => {
    const raw = buildRawEmail({ from: 'not-an-address' });
    const parsed = await parseRawMessage(raw, { maxBodyChars: 1_000 });
    expect(parsed.from).toEqual([]);
    expect(parsed.warnings).toContain('invalid_address_ignored:from');
  });

  it('parses unstructured input defensively', async () => {
    const parsed = await parseRawMessage(Buffer.from('this is not a mime message'), {
      maxBodyChars: 100,
    });
    expect(parsed.subject).toBe('');
    expect(parsed.from).toEqual([]);
    expect(Array.isArray(parsed.attachments)).toBe(true);
  });
});
