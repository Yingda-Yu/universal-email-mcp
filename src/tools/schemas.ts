import { z } from 'zod';
import { ACCOUNT_ID_PATTERN, DRAFT_ID_PATTERN } from '../config/schema.js';
import { LIMITS } from '../core/limits.js';

const accountId = z
  .string()
  .min(1)
  .max(64)
  .regex(ACCOUNT_ID_PATTERN, 'account_id must match ^[a-z0-9][a-z0-9_-]{0,63}$');
const folder = z.string().min(1).max(LIMITS.maxFolderChars).optional();
const limit = z.number().int().min(1).max(LIMITS.maxPageSize).default(LIMITS.defaultPageSize);
const cursor = z.string().min(1).max(LIMITS.maxCursorChars).optional();
const messageId = z.string().min(1).max(LIMITS.maxMessageRefChars);
const address = z.string().min(3).max(320);
const addressList = z.array(address).max(LIMITS.maxRecipients);

export const listAccountsShape = {};

export const listFoldersShape = {
  account_id: accountId.describe('Account identifier from email_list_accounts'),
};

export const listMessagesShape = {
  account_id: accountId.describe('Account identifier'),
  folder: folder.describe('Mailbox folder path; defaults to INBOX'),
  limit: limit.describe(`Page size (1-${LIMITS.maxPageSize})`),
  cursor: cursor.describe('Opaque next_cursor from the previous page'),
  unread_only: z.boolean().default(false).describe('Only return unread messages'),
};

export const searchMessagesShape = {
  account_id: accountId.describe('Account identifier'),
  query: z.string().min(1).max(LIMITS.maxSearchQueryChars).describe('Case-insensitive text search query'),
  folder: folder.describe('Mailbox folder path; defaults to INBOX'),
  limit: limit.describe(`Page size (1-${LIMITS.maxPageSize})`),
  cursor: cursor.describe('Opaque next_cursor from the previous page'),
  since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Inclusive lower bound date, YYYY-MM-DD'),
  before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Exclusive upper bound date, YYYY-MM-DD'),
};

export const getMessageShape = {
  account_id: accountId.describe('Account identifier'),
  message_id: messageId.describe('Opaque message_id returned by list/search/thread'),
  folder: folder.describe('Optional folder hint; must match the folder embedded in message_id'),
  include_html: z.boolean().default(false).describe('Include sanitized HTML body (disabled by default)'),
  max_body_chars: z
    .number()
    .int()
    .min(1)
    .max(100_000)
    .default(20_000)
    .describe('Maximum characters returned for each body part'),
};

export const getThreadShape = {
  account_id: accountId.describe('Account identifier'),
  message_id: messageId.describe('Any message_id in the thread'),
  limit: limit.describe('Maximum messages to return'),
};

export const createDraftShape = {
  account_id: accountId.describe('Account identifier'),
  to: addressList.min(1).describe('Recipients; accepts "user@example.com" or "Name <user@example.com>"'),
  cc: addressList.optional().describe('Cc recipients'),
  bcc: addressList.optional().describe('Bcc recipients'),
  subject: z.string().min(1).max(LIMITS.maxSubjectChars).describe('Subject; CR/LF are rejected'),
  text: z.string().max(LIMITS.maxBodyBytes).optional().describe('Plain-text body'),
  html: z.string().max(LIMITS.maxHtmlBytes).optional().describe('HTML body; treated as untrusted data when read back'),
  in_reply_to: z.string().min(3).max(LIMITS.maxMessageIdHeaderChars).optional().describe('Message-ID header value'),
  references: z.array(z.string().min(3).max(LIMITS.maxMessageIdHeaderChars)).max(LIMITS.maxReferences).optional(),
};

export const sendDraftShape = {
  account_id: accountId.describe('Account identifier'),
  draft_id: z.string().regex(DRAFT_ID_PATTERN, 'draft_id must be a local draft identifier').describe('Local draft identifier'),
  approval_token: z
    .string()
    .min(20)
    .max(200)
    .describe('Single-use token minted out-of-band by universal-email-mcp-approve'),
};

export const replyShape = {
  account_id: accountId.describe('Account identifier'),
  message_id: messageId.describe('Message being replied to'),
  folder: folder.describe('Optional folder hint'),
  text: z.string().max(LIMITS.maxBodyBytes).optional().describe('Plain-text reply body'),
  html: z.string().max(LIMITS.maxHtmlBytes).optional().describe('HTML reply body'),
  reply_all: z.boolean().default(false).describe('Include original To/Cc recipients, excluding the account address'),
};
