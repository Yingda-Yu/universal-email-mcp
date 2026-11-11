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

function notImplemented(): EmailMcpError {
  return new EmailMcpError(
    'PROVIDER_NOT_IMPLEMENTED',
    'Microsoft Graph OAuth support is reserved for a future release and is not implemented in v0.1.0',
  );
}

/**
 * Reserved Microsoft Graph adapter interface. OAuth token handling, token
 * storage, and the Graph API mapping are intentionally not implemented in
 * v0.1.0.
 */
export class MicrosoftGraphProvider implements EmailProvider {
  readonly kind = 'graph' as const;

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
    throw notImplemented();
  }

  async listMessages(_options: ListMessagesOptions): Promise<Page<MessageSummary>> {
    throw notImplemented();
  }

  async searchMessages(_options: SearchMessagesOptions): Promise<Page<MessageSummary>> {
    throw notImplemented();
  }

  async getMessage(_messageId: string, _options: GetMessageOptions): Promise<MessageDetail> {
    throw notImplemented();
  }

  async getThread(_messageId: string, _options: GetThreadOptions): Promise<ThreadResult> {
    throw notImplemented();
  }

  async send(_message: OutgoingMessage): Promise<SendReceipt> {
    throw notImplemented();
  }

  async close(): Promise<void> {
    // Nothing to close.
  }
}
