import { EmailMcpError } from '../../core/errors.js';
import { validateOutgoingMessage } from '../../core/outgoing.js';
import type { OutgoingMessage, ResolvedAccountConfig, SendReceipt } from '../../core/types.js';
import type { SmtpEnvelope, SmtpTransport } from './smtp-transport.js';

export class SmtpSender {
  private readonly config: ResolvedAccountConfig;
  private readonly transport: SmtpTransport;

  constructor(config: ResolvedAccountConfig, transport: SmtpTransport) {
    this.config = config;
    this.transport = transport;
  }

  async send(message: OutgoingMessage): Promise<SendReceipt> {
    if (!this.config.sendEnabled) {
      throw new EmailMcpError('SEND_DISABLED', 'Sending is disabled for this account in the server configuration');
    }
    if (this.config.smtp === null) {
      throw new EmailMcpError('CAPABILITY_UNSUPPORTED', 'This account has no SMTP endpoint configured');
    }
    const validated = validateOutgoingMessage(message);

    const envelope: SmtpEnvelope = {
      from: { name: this.config.label, address: this.config.email },
      to: validated.to,
      cc: validated.cc,
      bcc: validated.bcc,
      subject: validated.subject,
      text: validated.text,
      html: validated.html,
      inReplyTo: validated.inReplyTo,
      references: validated.references,
    };

    const result = await this.transport.send(envelope);
    if (result.accepted.length === 0) {
      throw new EmailMcpError('SMTP_SEND_FAILED', 'The SMTP server rejected every recipient', {
        details: { rejected_count: result.rejected.length },
      });
    }

    return {
      providerMessageId: result.messageId,
      accepted: result.accepted,
      rejected: result.rejected,
      response: result.response,
      partial: result.rejected.length > 0,
      sentAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.transport.close();
  }
}
