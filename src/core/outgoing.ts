import { EmailMcpError } from './errors.js';
import type { OutgoingMessage } from './types.js';
import {
  parseMailbox,
  validateBodySizes,
  validateMessageIdHeader,
  validateReferences,
  validateSubject,
} from './validate.js';

export interface ValidatedOutgoingMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string | null;
  html: string | null;
  inReplyTo: string | null;
  references: string[];
}

function uniqueAddresses(addresses: readonly string[], field: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const input of addresses) {
    const address = parseMailbox(input, field).address;
    const key = address.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(address);
    }
  }
  return result;
}

export function validateOutgoingMessage(message: OutgoingMessage): ValidatedOutgoingMessage {
  const to = uniqueAddresses(
    message.to.map((address) => address.address),
    'to',
  );
  const cc = uniqueAddresses(
    message.cc.map((address) => address.address),
    'cc',
  );
  const bcc = uniqueAddresses(
    message.bcc.map((address) => address.address),
    'bcc',
  );
  const toSet = new Set(to.map((address) => address.toLowerCase()));
  const filteredCc = cc.filter((address) => !toSet.has(address.toLowerCase()));
  const recipientKeys = new Set([...to, ...filteredCc].map((address) => address.toLowerCase()));
  const filteredBcc = bcc.filter((address) => !recipientKeys.has(address.toLowerCase()));

  if (to.length === 0) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'At least one recipient is required');
  }
  if (to.length + filteredCc.length + filteredBcc.length > 20) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'Too many recipients');
  }
  const subject = validateSubject(message.subject);
  validateBodySizes(message.text, message.html);
  if (
    (message.text === null || message.text.trim().length === 0) &&
    (message.html === null || message.html.trim().length === 0)
  ) {
    throw new EmailMcpError('INVALID_ARGUMENT', 'A message must contain text or HTML content');
  }
  const inReplyTo = message.inReplyTo === null ? null : validateMessageIdHeader(message.inReplyTo, 'in_reply_to');
  const references = validateReferences(message.references);

  return {
    to,
    cc: filteredCc,
    bcc: filteredBcc,
    subject,
    text: message.text,
    html: message.html,
    inReplyTo,
    references,
  };
}
