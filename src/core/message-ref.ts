import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';

export type MessageRefKind = 'imap1' | 'mock1';

export interface DecodedMessageRef {
  kind: MessageRefKind;
  folder: string;
  uidValidity: string;
  uid: number;
}

const REF_PATTERN = /^(imap1|mock1)\.([A-Za-z0-9_-]+)\.(\d{1,20})\.(\d{1,20})$/;

export function encodeMessageRef(
  kind: MessageRefKind,
  folder: string,
  uidValidity: string | number | bigint,
  uid: number,
): string {
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'UID must be a positive safe integer');
  }
  if (folder.length === 0 || folder.length > LIMITS.maxFolderChars) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'Folder path is empty or too long');
  }
  const validity = uidValidity.toString();
  if (!/^\d{1,20}$/.test(validity)) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'UIDVALIDITY must be a non-negative integer');
  }
  return `${kind}.${Buffer.from(folder, 'utf8').toString('base64url')}.${validity}.${uid}`;
}

export function decodeMessageRef(ref: string, expectedKind?: MessageRefKind): DecodedMessageRef {
  if (typeof ref !== 'string' || ref.length === 0 || ref.length > LIMITS.maxMessageRefChars) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id is empty or too long');
  }
  const match = REF_PATTERN.exec(ref);
  if (!match) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id is not a valid provider message reference');
  }
  const kind = match[1] as MessageRefKind;
  const encodedFolder = match[2] ?? '';
  const uidValidity = match[3] ?? '';
  const uid = Number.parseInt(match[4] ?? '', 10);
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new EmailMcpError('INVALID_ARGUMENT', `message_id belongs to a ${kind} provider, not ${expectedKind}`);
  }
  if (!Number.isSafeInteger(uid) || uid <= 0) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id contains an invalid UID');
  }
  let folder: string;
  try {
    folder = Buffer.from(encodedFolder, 'base64url').toString('utf8');
  } catch {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id contains an invalid folder encoding');
  }
  if (folder.length === 0 || folder.length > LIMITS.maxFolderChars) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id contains an invalid folder');
  }
  if (Buffer.from(folder, 'utf8').toString('base64url') !== encodedFolder) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'message_id folder encoding is not canonical');
  }
  return { kind, folder, uidValidity, uid };
}
