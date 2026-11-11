import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { EmailMcpError } from '../../core/errors.js';
import { redactString, truncateForError } from '../../core/redact.js';
import type { EndpointConfig } from '../../core/types.js';
import { VERSION } from '../../version.js';

export interface SmtpEnvelope {
  from: { name: string; address: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
}

export interface SmtpResult {
  messageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string;
}

export interface SmtpTransport {
  send(envelope: SmtpEnvelope): Promise<SmtpResult>;
  close(): Promise<void>;
}

export interface SmtpTransportOptions {
  endpoint: EndpointConfig;
  username: string;
  password: string;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}

export function mapSmtpError(error: unknown): EmailMcpError {
  if (error instanceof EmailMcpError) {
    return error;
  }
  const candidate = error as {
    code?: string;
    message?: string;
    response?: string;
    responseCode?: number;
  };
  const message = redactString(
    truncateForError(candidate.message ?? candidate.response ?? 'SMTP send failed'),
  );
  const code = candidate.code ?? '';
  if (code === 'EAUTH' || candidate.responseCode === 535 || /authentication/i.test(message)) {
    return new EmailMcpError('AUTHENTICATION_FAILED', 'SMTP authentication failed', { cause: error });
  }
  if (code === 'ETIMEDOUT' || /timeout/i.test(message)) {
    return new EmailMcpError('TIMEOUT', 'SMTP operation timed out', { retryable: true, cause: error });
  }
  if (code === 'EENVELOPE' || code === 'EMESSAGE') {
    return new EmailMcpError('SMTP_SEND_FAILED', message, {
      details:
        candidate.responseCode === undefined ? undefined : { smtp_response_code: candidate.responseCode },
      cause: error,
    });
  }
  if (code === 'ECONNECTION' || code === 'ESOCKET' || code === 'EDNS') {
    return new EmailMcpError('CONNECTION_FAILED', 'Could not connect to the SMTP server', {
      retryable: true,
      cause: error,
    });
  }
  return new EmailMcpError('SMTP_SEND_FAILED', message, {
    details:
      candidate.responseCode === undefined ? undefined : { smtp_response_code: candidate.responseCode },
    cause: error,
  });
}

export class NodemailerSmtpTransport implements SmtpTransport {
  private readonly transporter: Transporter;

  constructor(options: SmtpTransportOptions) {
    const { endpoint } = options;
    this.transporter = nodemailer.createTransport({
      host: endpoint.host,
      port: endpoint.port,
      secure: endpoint.secure,
      requireTLS: endpoint.requireTls,
      auth: {
        user: options.username,
        pass: options.password,
      },
      tls: {
        rejectUnauthorized: true,
        minVersion: 'TLSv1.2',
        servername: endpoint.host,
      },
      connectionTimeout: options.connectionTimeoutMs ?? 15_000,
      greetingTimeout: options.greetingTimeoutMs ?? 10_000,
      socketTimeout: options.socketTimeoutMs ?? 30_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
  }

  async send(envelope: SmtpEnvelope): Promise<SmtpResult> {
    try {
      const info = await this.transporter.sendMail({
        from: envelope.from,
        to: envelope.to,
        cc: envelope.cc.length > 0 ? envelope.cc : undefined,
        bcc: envelope.bcc.length > 0 ? envelope.bcc : undefined,
        subject: envelope.subject,
        text: envelope.text ?? undefined,
        html: envelope.html ?? undefined,
        inReplyTo: envelope.inReplyTo ?? undefined,
        references: envelope.references.length > 0 ? envelope.references : undefined,
        headers: {
          'X-Mailer': `universal-email-mcp/${VERSION}`,
        },
      });
      const accepted = Array.isArray(info.accepted) ? info.accepted.map(String) : [];
      const rejected = Array.isArray(info.rejected) ? info.rejected.map(String) : [];
      return {
        messageId: typeof info.messageId === 'string' ? info.messageId : null,
        accepted,
        rejected,
        response: typeof info.response === 'string' ? redactString(info.response) : '',
      };
    } catch (error) {
      throw mapSmtpError(error);
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
