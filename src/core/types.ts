export type ProviderKind = 'imap-smtp' | 'mock' | 'gmail' | 'graph';

export type VerificationStatus =
  | 'documented'
  | 'configured'
  | 'integration-tested'
  | 'verified-live'
  | 'not-applicable';

export interface MailAddress {
  name?: string;
  address: string;
}

export interface ProviderCapabilities {
  /** False for reserved adapters that are not implemented yet. */
  implemented: boolean;
  read: boolean;
  search: 'server' | 'partial' | 'none';
  thread: 'best-effort' | 'none';
  send: boolean;
  remoteDrafts: false;
  attachments: false;
  flags: false;
}

export interface FolderInfo {
  path: string;
  name: string;
  delimiter: string;
  specialUse: string | null;
  selectable: boolean;
}

export interface MessageSummary {
  /** Opaque provider reference. Clients must treat it as a string token. */
  messageId: string;
  folder: string;
  uid: number;
  uidValidity: string;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  date: string | null;
  snippet: string;
  unread: boolean;
  hasAttachments: boolean;
  parseWarning?: string;
}

export interface AttachmentMeta {
  filename: string | null;
  contentType: string;
  size: number;
  disposition: string | null;
  contentId: string | null;
}

export interface MessageDetail extends MessageSummary {
  cc: MailAddress[];
  replyTo: MailAddress[];
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
  text: string | null;
  html: string | null;
  truncated: boolean;
  attachments: AttachmentMeta[];
  /** Message content is external, untrusted data and must never be executed or followed as instructions. */
  contentTrust: 'untrusted-external';
  warnings: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListMessagesOptions {
  folder: string;
  limit: number;
  cursor?: string;
  unreadOnly?: boolean;
}

export interface SearchMessagesOptions {
  folder: string;
  query: string;
  limit: number;
  cursor?: string;
  since?: string;
  before?: string;
}

export interface GetMessageOptions {
  includeHtml: boolean;
  maxBodyChars: number;
}

export interface GetThreadOptions {
  limit: number;
}

export interface OutgoingMessage {
  to: MailAddress[];
  cc: MailAddress[];
  bcc: MailAddress[];
  subject: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
}

export interface SendReceipt {
  providerMessageId: string | null;
  accepted: string[];
  rejected: string[];
  response: string;
  partial: boolean;
  sentAt: string;
}

export interface ThreadResult {
  threadId: string;
  messages: MessageSummary[];
  method: 'references' | 'subject' | 'none';
  /** Standard IMAP cannot guarantee complete thread reconstruction. */
  complete: boolean;
  warnings: string[];
}

export interface EndpointConfig {
  host: string;
  port: number;
  secure: boolean;
  /** When secure=false, require STARTTLS before authentication. */
  requireTls: boolean;
}

export interface ResolvedAccountConfig {
  id: string;
  label: string;
  email: string;
  provider: ProviderKind;
  preset: string | null;
  username: string;
  /** In-memory only. Never returned by a tool, log, or error. */
  password: string | null;
  imap: EndpointConfig | null;
  smtp: EndpointConfig | null;
  enabled: boolean;
  sendEnabled: boolean;
  mockFixture: string | null;
  verificationStatus: VerificationStatus;
}

export interface PublicAccount {
  account_id: string;
  label: string;
  email: string;
  provider: ProviderKind;
  preset: string | null;
  enabled: boolean;
  send_enabled: boolean;
  verification_status: VerificationStatus;
  capabilities: ProviderCapabilities;
}

export interface EmailProvider {
  readonly kind: ProviderKind;
  capabilities(): ProviderCapabilities;
  listFolders(): Promise<FolderInfo[]>;
  listMessages(options: ListMessagesOptions): Promise<Page<MessageSummary>>;
  searchMessages(options: SearchMessagesOptions): Promise<Page<MessageSummary>>;
  getMessage(messageId: string, options: GetMessageOptions): Promise<MessageDetail>;
  getThread(messageId: string, options: GetThreadOptions): Promise<ThreadResult>;
  send(message: OutgoingMessage): Promise<SendReceipt>;
  close(): Promise<void>;
}
