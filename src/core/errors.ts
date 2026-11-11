/**
 * Stable, machine-readable error codes returned by every MCP tool.
 * Adding a code is backward compatible; renaming one is not.
 */
export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'UNKNOWN_ACCOUNT',
  'ACCOUNT_DISABLED',
  'AMBIGUOUS_ACCOUNT',
  'CAPABILITY_UNSUPPORTED',
  'PROVIDER_NOT_IMPLEMENTED',
  'AUTHENTICATION_FAILED',
  'CONNECTION_FAILED',
  'TIMEOUT',
  'FOLDER_NOT_FOUND',
  'MESSAGE_NOT_FOUND',
  'MESSAGE_STALE',
  'DRAFT_NOT_FOUND',
  'DRAFT_ALREADY_SENT',
  'DRAFT_CONTENT_CHANGED',
  'APPROVAL_REQUIRED',
  'APPROVAL_INVALID',
  'APPROVAL_EXPIRED',
  'APPROVAL_ALREADY_USED',
  'SEND_DISABLED',
  'RECIPIENT_NOT_ALLOWED',
  'RATE_LIMITED',
  'SIZE_LIMIT_EXCEEDED',
  'HEADER_INJECTION_BLOCKED',
  'CONFIG_INVALID',
  'SECURITY_BLOCKED',
  'PROVIDER_ERROR',
  'MIME_PARSE_FAILED',
  'SMTP_SEND_FAILED',
  'PARTIAL_DELIVERY',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface EmailMcpErrorOptions {
  details?: Record<string, unknown>;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * The only error type that should cross the tool boundary. Anything else is
 * treated as an internal error and reported without leaking implementation
 * details or secrets.
 */
export class EmailMcpError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: EmailMcpErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'EmailMcpError';
    this.code = code;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

export function isEmailMcpError(value: unknown): value is EmailMcpError {
  return value instanceof EmailMcpError;
}

export function invalidArgument(message: string, details?: Record<string, unknown>): EmailMcpError {
  return new EmailMcpError('INVALID_ARGUMENT', message, { details });
}

export function notFound(message: string, details?: Record<string, unknown>): EmailMcpError {
  return new EmailMcpError('MESSAGE_NOT_FOUND', message, { details });
}
