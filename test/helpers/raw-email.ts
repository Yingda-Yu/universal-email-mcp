export interface RawAttachment {
  filename: string;
  content: string;
  contentType?: string;
}

export interface RawEmailOptions {
  from?: string;
  to?: string | string[];
  cc?: string | string[];
  subject?: string;
  date?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  text?: string | null;
  html?: string | null;
  attachments?: RawAttachment[];
  extraHeaders?: Record<string, string>;
}

function encodeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\u0000-\u007F]*$/.test(value)) {
    return value;
  }
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function headerLines(options: RawEmailOptions): string[] {
  const lines: string[] = [];
  const from = options.from ?? 'Sender <sender@example.com>';
  const to = Array.isArray(options.to) ? options.to.join(', ') : (options.to ?? 'recipient@example.com');
  lines.push(`From: ${from}`);
  lines.push(`To: ${to}`);
  if (options.cc !== undefined) {
    lines.push(`Cc: ${Array.isArray(options.cc) ? options.cc.join(', ') : options.cc}`);
  }
  lines.push(`Subject: ${encodeHeaderValue(options.subject ?? 'Test message')}`);
  if (options.date !== null) {
    lines.push(`Date: ${options.date ?? 'Tue, 04 Nov 2026 10:00:00 +0000'}`);
  }
  if (options.messageId !== null) {
    lines.push(`Message-ID: ${options.messageId ?? '<test-message@example.com>'}`);
  }
  if (options.inReplyTo !== null && options.inReplyTo !== undefined) {
    lines.push(`In-Reply-To: ${options.inReplyTo}`);
  }
  if (options.references !== undefined && options.references.length > 0) {
    lines.push(`References: ${options.references.join(' ')}`);
  }
  for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('MIME-Version: 1.0');
  return lines;
}

function base64Body(value: string, contentType: string): string {
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const wrapped = encoded.match(/.{1,76}/g) ?? [];
  return [
    `Content-Type: ${contentType}; charset=utf-8`,
    'Content-Transfer-Encoding: base64',
    '',
    ...wrapped,
  ].join('\r\n');
}

function alternativePart(text: string | null, html: string | null, boundary: string): string[] {
  return [
    `--${boundary}`,
    ...base64Body(text ?? '', 'text/plain').split('\r\n'),
    `--${boundary}`,
    ...base64Body(html ?? '', 'text/html').split('\r\n'),
    `--${boundary}--`,
  ];
}

/**
 * Builds a deterministic RFC 5322 message for MIME parser and fake IMAP tests.
 * No network access is involved.
 */
export function buildRawEmail(options: RawEmailOptions = {}): Buffer {
  const headers = headerLines(options);
  const attachments = options.attachments ?? [];
  const hasHtml = options.html !== null && options.html !== undefined;
  const text = options.text ?? 'Hello from the test suite.';

  if (attachments.length > 0) {
    const mixedBoundary = 'mixed-boundary-example-0001';
    const alternativeBoundary = 'alternative-boundary-example-0001';
    const lines = [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
      '',
      `--${mixedBoundary}`,
    ];
    if (hasHtml) {
      lines.push(`Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`, '');
      lines.push(...alternativePart(text, options.html ?? null, alternativeBoundary));
    } else {
      lines.push(...base64Body(text, 'text/plain').split('\r\n'));
    }
    for (const attachment of attachments) {
      lines.push(
        `--${mixedBoundary}`,
        `Content-Type: ${attachment.contentType ?? 'application/octet-stream'}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${attachment.filename}"`,
        '',
        Buffer.from(attachment.content, 'utf8').toString('base64'),
      );
    }
    lines.push(`--${mixedBoundary}--`, '');
    return Buffer.from(lines.join('\r\n'), 'utf8');
  }

  if (hasHtml) {
    const alternativeBoundary = 'alternative-boundary-example-0002';
    const lines = [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      ...alternativePart(text, options.html ?? null, alternativeBoundary),
      '',
    ];
    return Buffer.from(lines.join('\r\n'), 'utf8');
  }

  const lines = [...headers, ...base64Body(text, 'text/plain').split('\r\n'), ''];
  return Buffer.from(lines.join('\r\n'), 'utf8');
}
