import { simpleParser } from 'mailparser';
import type { Attachment, EmailAddress, ParsedMail } from 'mailparser';
import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';
import { redactString } from './redact.js';
import type { AttachmentMeta, MailAddress } from './types.js';
import { isValidEmailAddress } from './validate.js';

export interface ParsedRawMessage {
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  replyTo: MailAddress[];
  date: Date | null;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string | null;
  html: string | null;
  truncated: boolean;
  attachments: AttachmentMeta[];
  warnings: string[];
}

export interface ParseRawMessageOptions {
  maxBodyChars: number;
}

const DANGEROUS_TAGS = ['script', 'iframe', 'object', 'embed', 'form', 'meta', 'link', 'base', 'style'];

/**
 * Conservative cleanup for message HTML. This is not a general XSS sanitizer and
 * the output should still be treated as untrusted data, never rendered by the
 * MCP server. It removes active content that has no place in an email body.
 */
export function sanitizeUntrustedHtml(html: string): string {
  let output = html;
  for (const tag of DANGEROUS_TAGS) {
    output = output.replace(new RegExp(`<\\s*${tag}\\b[^>]*>[\\s\\S]*?<\\s*/\\s*${tag}\\s*>`, 'gi'), '');
    output = output.replace(new RegExp(`<\\s*${tag}\\b[^>]*/?>`, 'gi'), '');
  }
  output = output.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  output = output.replace(/javascript\s*:/gi, 'blocked:');
  output = output.replace(/vbscript\s*:/gi, 'blocked:');
  return output;
}

export function stripHtmlToText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function makeSnippet(text: string | null, html: string | null, max = 200): string {
  const source = text && text.trim().length > 0 ? text : html ? stripHtmlToText(html) : '';
  return source.replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeHeaderId(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > LIMITS.maxMessageIdHeaderChars) {
    return null;
  }
  const match = /<([^<>\s]+)>/.exec(trimmed);
  if (match && match[1] !== undefined) {
    return `<${match[1]}>`;
  }
  if (/^[^<>\s]+$/.test(trimmed)) {
    return `<${trimmed}>`;
  }
  return null;
}

function normalizeReferences(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  const candidates = Array.isArray(value) ? value : value.split(/\s+/);
  const result: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizeHeaderId(candidate);
    if (normalized !== null && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result.slice(-LIMITS.maxReferences);
}

function toMailAddresses(addresses: EmailAddress[] | undefined, warnings: string[], field: string): MailAddress[] {
  if (addresses === undefined) {
    return [];
  }
  const result: MailAddress[] = [];
  for (const entry of addresses) {
    const address = entry.address;
    if (typeof address !== 'string' || !isValidEmailAddress(address)) {
      warnings.push(`invalid_address_ignored:${field}`);
      continue;
    }
    const name = typeof entry.name === 'string' && entry.name.trim().length > 0 ? entry.name.trim() : undefined;
    result.push(name === undefined ? { address } : { name, address });
  }
  return result;
}

function collectAddresses(
  value: ParsedMail['to'],
  warnings: string[],
  field: string,
): MailAddress[] {
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((group) => toMailAddresses(group.value, warnings, field));
  }
  return toMailAddresses(value.value, warnings, field);
}

function toAttachmentMeta(attachment: Attachment): AttachmentMeta {
  const filename =
    typeof attachment.filename === 'string' && attachment.filename.trim().length > 0
      // eslint-disable-next-line no-control-regex
      ? attachment.filename.replace(/[\u0000-\u001F\u007F]/g, '').slice(0, 255)
      : null;
  return {
    filename,
    contentType: attachment.contentType || 'application/octet-stream',
    size: Number.isFinite(attachment.size) ? attachment.size : 0,
    disposition: attachment.contentDisposition ?? null,
    contentId: attachment.cid ?? null,
  };
}

function truncateBody(value: string | null, maxChars: number): { value: string | null; truncated: boolean } {
  if (value === null) {
    return { value: null, truncated: false };
  }
  if (value.length <= maxChars) {
    return { value, truncated: false };
  }
  return { value: value.slice(0, maxChars), truncated: true };
}

export async function parseRawMessage(
  source: Buffer | string,
  options: ParseRawMessageOptions,
): Promise<ParsedRawMessage> {
  const warnings: string[] = [];
  const raw = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
  try {
    const parsed = await simpleParser(raw, { skipTextToHtml: true });
    const from = collectAddresses(parsed.from, warnings, 'from');
    const to = collectAddresses(parsed.to, warnings, 'to');
    const cc = collectAddresses(parsed.cc, warnings, 'cc');
    const bcc = collectAddresses(parsed.bcc, warnings, 'bcc');
    const replyTo = collectAddresses(parsed.replyTo, warnings, 'reply_to');

    let text = typeof parsed.text === 'string' && parsed.text.trim().length > 0 ? parsed.text : null;
    let html =
      typeof parsed.html === 'string' && parsed.html.trim().length > 0
        ? sanitizeUntrustedHtml(parsed.html)
        : null;
    if (html !== null) {
      warnings.push('html_sanitized');
    }
    const textTruncation = truncateBody(text, options.maxBodyChars);
    const htmlTruncation = truncateBody(html, options.maxBodyChars);
    text = textTruncation.value;
    html = htmlTruncation.value;
    if (textTruncation.truncated || htmlTruncation.truncated) {
      warnings.push('body_truncated');
    }

    const date = parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime()) ? parsed.date : null;
    if (parsed.date !== undefined && date === null) {
      warnings.push('invalid_date_header');
    }

    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject.slice(0, LIMITS.maxSubjectChars) : '',
      from,
      to,
      cc,
      bcc,
      replyTo,
      date,
      messageIdHeader: normalizeHeaderId(parsed.messageId),
      inReplyTo: normalizeHeaderId(parsed.inReplyTo),
      references: normalizeReferences(parsed.references),
      text,
      html,
      truncated: textTruncation.truncated || htmlTruncation.truncated,
      attachments: parsed.attachments.map(toAttachmentMeta),
      warnings,
    };
  } catch (error) {
    const fallback = parseHeadersAndBodyFallback(raw, options.maxBodyChars);
    fallback.warnings.push('mime_parse_fallback');
    if (error instanceof Error) {
      fallback.warnings.push(`mime_parser_error:${redactString(error.message).slice(0, 120)}`);
    }
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Fallback parser for malformed MIME. Deliberately small and defensive.
// ---------------------------------------------------------------------------

function parseHeaderLines(headerBlock: string): Map<string, string> {
  const headers = new Map<string, string>();
  const lines = headerBlock.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentValue = '';
  const flush = (): void => {
    if (currentKey !== null) {
      headers.set(currentKey, currentValue.trim());
    }
  };
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      currentValue += ` ${line.trim()}`;
      continue;
    }
    flush();
    const separator = line.indexOf(':');
    if (separator <= 0) {
      currentKey = null;
      currentValue = '';
      continue;
    }
    currentKey = line.slice(0, separator).trim().toLowerCase();
    currentValue = line.slice(separator + 1);
  }
  flush();
  return headers;
}

function decodeMimeWords(input: string): string {
  return input.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset: string, encoding: string, data: string) => {
    try {
      const buffer =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(data, 'base64')
          : Buffer.from(
              data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
                String.fromCharCode(Number.parseInt(hex, 16)),
              ),
              'binary',
            );
      const label = charset.toLowerCase().replace(/_/g, '-');
      return new TextDecoder(label).decode(buffer);
    } catch {
      return _match;
    }
  });
}

function decodeTransferBody(body: string, encoding: string | undefined): string {
  const normalized = (encoding ?? '').toLowerCase().trim();
  try {
    if (normalized === 'base64') {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    }
    if (normalized === 'quoted-printable') {
      return Buffer.from(
        body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) =>
          String.fromCharCode(Number.parseInt(hex, 16)),
        ),
        'binary',
      ).toString('utf8');
    }
  } catch {
    return body;
  }
  return body;
}

function splitAddressHeader(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let angleDepth = 0;
  let quoted = false;
  for (const char of value) {
    if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === '<') {
      angleDepth += 1;
    } else if (!quoted && char === '>' && angleDepth > 0) {
      angleDepth -= 1;
    }
    if (char === ',' && angleDepth === 0 && !quoted) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim().length > 0) {
    parts.push(current.trim());
  }
  return parts;
}

function fallbackAddresses(value: string | undefined, warnings: string[], field: string): MailAddress[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  const result: MailAddress[] = [];
  for (const part of splitAddressHeader(decodeMimeWords(value))) {
    const match = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>]+)>\s*$/.exec(part);
    const address = (match?.[2] ?? part).trim();
    if (!isValidEmailAddress(address)) {
      warnings.push(`invalid_address_ignored:${field}`);
      continue;
    }
    const name = match?.[1]?.trim();
    result.push(name && name.length > 0 ? { name, address } : { address });
  }
  return result;
}

function parseHeadersAndBodyFallback(raw: Buffer, maxBodyChars: number): ParsedRawMessage {
  const warnings: string[] = [];
  const textSource = raw.toString('utf8');
  const separatorMatch = /\r?\n\r?\n/.exec(textSource);
  const headerBlock = separatorMatch ? textSource.slice(0, separatorMatch.index) : textSource;
  const bodyBlock = separatorMatch ? textSource.slice(separatorMatch.index + separatorMatch[0].length) : '';
  const headers = parseHeaderLines(headerBlock);

  const subjectRaw = headers.get('subject');
  const subject = subjectRaw === undefined ? '' : decodeMimeWords(subjectRaw).slice(0, LIMITS.maxSubjectChars);
  const contentType = headers.get('content-type') ?? '';
  const charsetMatch = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  let body = decodeTransferBody(bodyBlock, headers.get('content-transfer-encoding'));
  if (charsetMatch?.[1] !== undefined) {
    try {
      body = new TextDecoder(charsetMatch[1]).decode(Buffer.from(body, 'utf8'));
    } catch {
      warnings.push('unsupported_charset');
    }
  }

  const isHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const sanitizedHtml = isHtml ? sanitizeUntrustedHtml(body) : null;
  const text = isHtml ? null : body;
  const dateRaw = headers.get('date');
  const parsedDate = dateRaw === undefined ? null : new Date(dateRaw);
  const date = parsedDate !== null && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null;
  if (dateRaw !== undefined && date === null) {
    warnings.push('invalid_date_header');
  }
  const textTruncation = truncateBody(text, maxBodyChars);
  const htmlTruncation = truncateBody(sanitizedHtml, maxBodyChars);
  if (textTruncation.truncated || htmlTruncation.truncated) {
    warnings.push('body_truncated');
  }

  return {
    subject,
    from: fallbackAddresses(headers.get('from'), warnings, 'from'),
    to: fallbackAddresses(headers.get('to'), warnings, 'to'),
    cc: fallbackAddresses(headers.get('cc'), warnings, 'cc'),
    bcc: fallbackAddresses(headers.get('bcc'), warnings, 'bcc'),
    replyTo: fallbackAddresses(headers.get('reply-to'), warnings, 'reply_to'),
    date,
    messageIdHeader: normalizeHeaderId(headers.get('message-id')),
    inReplyTo: normalizeHeaderId(headers.get('in-reply-to')),
    references: normalizeReferences(headers.get('references')),
    text: textTruncation.value,
    html: htmlTruncation.value,
    truncated: textTruncation.truncated || htmlTruncation.truncated,
    attachments: [],
    warnings,
  };
}

export function assertMessageSize(bytes: number, max = LIMITS.maxMessageBytes): void {
  if (bytes > max) {
    throw new EmailMcpError('SIZE_LIMIT_EXCEEDED', `Message exceeds the ${max} byte retrieval limit`, {
      details: { max_bytes: max },
    });
  }
}
