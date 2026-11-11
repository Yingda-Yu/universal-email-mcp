import { EmailMcpError } from '../../core/errors.js';
import type {
  EmailProvider,
  FolderInfo,
  GetMessageOptions,
  GetThreadOptions,
  ListMessagesOptions,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  Page,
  ProviderCapabilities,
  SearchMessagesOptions,
  SendReceipt,
  ThreadResult,
} from '../../core/types.js';

function notImplemented(provider: string): EmailMcpError {
  return new EmailMcpError(
    'PROVIDER_NOT_IMPLEMENTED',
    `${provider} OAuth support is reserved for a future release and is not implemented in v0.1.0`,
  );
}

/**
 * Reserved Gmail API adapter interface. OAuth token handling, token storage, and
 * the API mapping are intentionally not implemented in v0.1.0.
 */
export class GmailApiProvider implements EmailProvider {
  readonly kind = 'gmail' as const;

  capabilities(): ProviderCapabilities {
    return {
      implemented: false,
      read: false,
      search: 'none',
      thread: 'none',
      send: false,
      remoteDrafts: false,
      attachments: false,
      flags: false,
    };
  }

  async listFolders(): Promise<FolderInfo[]> {
    throw notImplemented('Gmail API');
  }

  async listMessages(_options: ListMessagesOptions): Promise<Page<MessageSummary>> {
    throw notImplemented('Gmail API');
  }

  async searchMessages(_options: SearchMessagesOptions): Promise<Page<MessageSummary>> {
    throw notImplemented('Gmail API');
  }

  async getMessage(_messageId: string, _options: GetMessageOptions): Promise<MessageDetail> {
    throw notImplemented('Gmail API');
  }

  async getThread(_messageId: string, _options: GetThreadOptions): Promise<ThreadResult> {
    throw notImplemented('Gmail API');
  }

  async send(_message: OutgoingMessage): Promise<SendReceipt> {
    throw notImplemented('Gmail API');
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
