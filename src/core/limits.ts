export const LIMITS = {
  /** Maximum configured accounts in one server process. */
  maxAccounts: 50,
  /** Maximum page size accepted by list/search tools. */
  maxPageSize: 50,
  defaultPageSize: 20,
  maxSearchQueryChars: 512,
  maxSubjectChars: 998,
  /** Maximum bytes for one text or HTML body part. */
  maxBodyBytes: 100_000,
  /** Maximum bytes for either body part when both are present. */
  maxHtmlBytes: 200_000,
  /** Maximum combined bytes of text + HTML in a draft. */
  maxCombinedBodyBytes: 250_000,
  maxRecipients: 20,
  maxCursorChars: 512,
  maxMessageRefChars: 1024,
  maxMessageIdHeaderChars: 998,
  maxReferences: 20,
  maxFolderChars: 512,
  maxMessageBytes: 25 * 1024 * 1024,
  maxThreadCandidates: 50,
  maxThreadMessages: 50,
  defaultApprovalTtlSeconds: 900,
  maxApprovalTtlSeconds: 3600,
  maxDraftFileBytes: 1_000_000,
  maxConfigFileBytes: 1_000_000,
  maxErrorDetailChars: 2_000,
} as const;

export const DEFAULT_FOLDER = 'INBOX';
