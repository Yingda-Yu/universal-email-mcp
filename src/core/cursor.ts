import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';

interface OffsetCursorPayload {
  v: 1;
  o: number;
}

interface UidCursorPayload {
  v: 1;
  u: number;
}

function encode(payload: OffsetCursorPayload | UidCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(cursor: string): OffsetCursorPayload | UidCursorPayload {
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > LIMITS.maxCursorChars) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'cursor is empty or too long');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new EmailMcpError('INVALID_ARGUMENT', 'cursor is not valid');
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { v?: unknown }).v !== 1) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'cursor version is not supported');
  }
  return parsed as OffsetCursorPayload | UidCursorPayload;
}

export function encodeOffsetCursor(offset: number): string {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new EmailMcpError('INTERNAL_ERROR', 'Invalid offset cursor');
  }
  return encode({ v: 1, o: offset });
}

export function decodeOffsetCursor(cursor: string): number {
  const parsed = decode(cursor);
  if (!('o' in parsed) || !Number.isSafeInteger(parsed.o) || parsed.o < 0) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'cursor does not contain a valid offset');
  }
  return parsed.o;
}

export function encodeUidCursor(uid: number): string {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new EmailMcpError('INTERNAL_ERROR', 'Invalid UID cursor');
  }
  return encode({ v: 1, u: uid });
}

export function decodeUidCursor(cursor: string): number {
  const parsed = decode(cursor);
  if (!('u' in parsed) || !Number.isSafeInteger(parsed.u) || parsed.u <= 0) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'cursor does not contain a valid UID');
  }
  return parsed.u;
}
