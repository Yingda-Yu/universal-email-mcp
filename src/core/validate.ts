import net from 'node:net';
import { EmailMcpError } from './errors.js';
import { LIMITS } from './limits.js';
import type { MailAddress } from './types.js';

const LOCAL_ATOM = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
const ANGLE_ADDRESS = /^\s*(?:"?([^"<>]*?)"?\s*)?<([^<>]+)>\s*$/;
const HEADER_CONTROL_CHARS = /[\r\n\0]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const BLOCKED_METADATA_HOSTS = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  '169.254.169.254',
  'fd00:ec2::254',
]);

export function assertNoControlChars(value: string, field: string, allowTab = false): void {
	if (HEADER_CONTROL_CHARS.test(value)) {
		throw new EmailMcpError('HEADER_INJECTION_BLOCKED', `${field} must not contain CR, LF, or NUL characters`);
	}
	// eslint-disable-next-line no-control-regex
	const pattern = allowTab ? CONTROL_CHARS : /[\u0000-\u001F\u007F]/;
	if (pattern.test(value)) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must not contain control characters`);
	}
}

export function isValidEmailAddress(input: string): boolean {
	if (input.length < 3 || input.length > 320) {
		return false;
	}
	// eslint-disable-next-line no-control-regex
	if (/[\s\u0000-\u001F\u007F]/.test(input)) {
		return false;
	}
	const at = input.lastIndexOf('@');
	if (at <= 0 || at === input.length - 1) {
		return false;
	}
	const local = input.slice(0, at);
	const domain = input.slice(at + 1);
	if (local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
		return false;
	}
	if (!LOCAL_ATOM.test(local)) {
		return false;
	}
	if (domain.length > 253 || domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
		return false;
	}
	const labels = domain.split('.');
	if (labels.length < 2) {
		return false;
	}
	return labels.every((label) => label.length >= 1 && label.length <= 63 && DOMAIN_LABEL.test(label));
}

/**
 * Accepts either `user@example.com` or `Display Name <user@example.com>`.
 * Rejects header injection and malformed addresses.
 */
export function parseMailbox(input: string, field = 'address'): MailAddress {
	if (typeof input !== 'string') {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must be a string`);
	}
	assertNoControlChars(input, field);
	const trimmed = input.trim();
	if (trimmed.length === 0) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must not be empty`);
	}
	const match = ANGLE_ADDRESS.exec(trimmed);
	let address: string;
	let name: string | undefined;
	if (match) {
		address = (match[2] ?? '').trim();
		const rawName = (match[1] ?? '').trim();
		if (rawName.length > 0) {
			if (rawName.length > 200) {
				throw new EmailMcpError('INVALID_ARGUMENT', `${field} display name is too long`);
			}
			name = rawName;
		}
	} else {
		address = trimmed;
	}
	if (!isValidEmailAddress(address)) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} is not a valid email address`);
	}
	return name === undefined ? { address } : { name, address };
}

export function normalizeAddressList(
	inputs: readonly string[] | undefined,
	field: string,
	max = LIMITS.maxRecipients,
): MailAddress[] {
	if (inputs === undefined) {
		return [];
	}
	if (inputs.length > max) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} exceeds the maximum of ${max} recipients`);
	}
	const result: MailAddress[] = [];
	const seen = new Set<string>();
	for (const input of inputs) {
		const mailbox = parseMailbox(input, field);
		const key = mailbox.address.toLowerCase();
		if (!seen.has(key)) {
			seen.add(key);
			result.push(mailbox);
		}
	}
	return result;
}

export function validateSubject(subject: string): string {
	if (typeof subject !== 'string') {
		throw new EmailMcpError('INVALID_ARGUMENT', 'subject must be a string');
	}
	assertNoControlChars(subject, 'subject', true);
	const trimmed = subject.trim();
	if (trimmed.length === 0) {
		throw new EmailMcpError('INVALID_ARGUMENT', 'subject must not be empty');
	}
	if (trimmed.length > LIMITS.maxSubjectChars) {
		throw new EmailMcpError('INVALID_ARGUMENT', `subject exceeds ${LIMITS.maxSubjectChars} characters`);
	}
	return trimmed;
}

export function validateFolderPath(folder: string): string {
	if (typeof folder !== 'string') {
		throw new EmailMcpError('INVALID_ARGUMENT', 'folder must be a string');
	}
	if (folder.length === 0 || folder.length > LIMITS.maxFolderChars) {
		throw new EmailMcpError('INVALID_ARGUMENT', 'folder path is empty or too long');
	}
	assertNoControlChars(folder, 'folder');
	if (folder === '.' || folder === '..' || folder.includes('/../') || folder.includes('\\..\\')) {
		throw new EmailMcpError('INVALID_ARGUMENT', 'folder path contains a traversal sequence');
	}
	return folder;
}

export function validateSearchQuery(query: string): string {
	if (typeof query !== 'string') {
		throw new EmailMcpError('INVALID_ARGUMENT', 'query must be a string');
	}
	assertNoControlChars(query, 'query', true);
	const trimmed = query.trim();
	if (trimmed.length === 0) {
		throw new EmailMcpError('INVALID_ARGUMENT', 'query must not be empty');
	}
	if (trimmed.length > LIMITS.maxSearchQueryChars) {
		throw new EmailMcpError('INVALID_ARGUMENT', `query exceeds ${LIMITS.maxSearchQueryChars} characters`);
	}
	return trimmed;
}

export function validateBodySizes(text: string | null, html: string | null): void {
	const textBytes = text === null ? 0 : Buffer.byteLength(text, 'utf8');
	const htmlBytes = html === null ? 0 : Buffer.byteLength(html, 'utf8');
	if (text !== null && textBytes > LIMITS.maxBodyBytes) {
		throw new EmailMcpError('SIZE_LIMIT_EXCEEDED', `text body exceeds ${LIMITS.maxBodyBytes} bytes`);
	}
	if (html !== null && htmlBytes > LIMITS.maxHtmlBytes) {
		throw new EmailMcpError('SIZE_LIMIT_EXCEEDED', `HTML body exceeds ${LIMITS.maxHtmlBytes} bytes`);
	}
	if (textBytes + htmlBytes > LIMITS.maxCombinedBodyBytes) {
		throw new EmailMcpError('SIZE_LIMIT_EXCEEDED', 'combined body size exceeds the limit');
	}
}

export function validateMessageIdHeader(value: string, field = 'message_id_header'): string {
	if (typeof value !== 'string') {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must be a string`);
	}
	assertNoControlChars(value, field);
	const trimmed = value.trim();
	if (trimmed.length === 0 || trimmed.length > LIMITS.maxMessageIdHeaderChars) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} has an invalid length`);
	}
	if (!/^<[^<>\s]+>$/.test(trimmed)) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must be a single Message-ID enclosed in angle brackets`);
	}
	return trimmed;
}

export function validateReferences(values: readonly string[] | undefined): string[] {
	if (values === undefined) {
		return [];
	}
	if (values.length > LIMITS.maxReferences) {
		throw new EmailMcpError('INVALID_ARGUMENT', `references exceeds ${LIMITS.maxReferences} entries`);
	}
	return values.map((value) => validateMessageIdHeader(value, 'references'));
}

export function validateIsoDate(value: string, field: string): Date {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} must use YYYY-MM-DD format`);
	}
	const date = new Date(`${value}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} is not a valid calendar date`);
	}
	return date;
}

export function assertSafeLocalId(value: string, field: string, pattern: RegExp): void {
	if (!pattern.test(value)) {
		throw new EmailMcpError('INVALID_ARGUMENT', `${field} has an invalid format`);
	}
}

export function parseBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value === '') {
		return defaultValue;
	}
	if (value === 'true' || value === '1') {
		return true;
	}
	if (value === 'false' || value === '0') {
		return false;
	}
	throw new EmailMcpError('CONFIG_INVALID', 'Boolean environment variables must be true/false or 1/0');
}

export function isLoopbackHost(host: string): boolean {
	const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
	return normalized === 'localhost' || normalized === '::1' || /^127\./.test(normalized);
}

export function isPrivateIp(address: string): boolean {
	const family = net.isIP(address);
	if (family === 4) {
		const parts = address.split('.').map((part) => Number.parseInt(part, 10));
		const [a, b] = parts;
		if (a === undefined || b === undefined) {
			return true;
		}
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 192 && b === 0) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (family === 6) {
		const normalized = address.toLowerCase();
		if (normalized === '::' || normalized === '::1') {
			return true;
		}
		if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
			return true;
		}
		if (/^fe[89ab]/.test(normalized)) {
			return true;
		}
		if (normalized.startsWith('::ffff:')) {
			return isPrivateIp(normalized.slice('::ffff:'.length));
		}
		return false;
	}
	return true;
}

export function assertSafeRemoteHost(host: string, allowPrivateHosts: boolean): string {
	const normalized = host.trim().toLowerCase();
	if (
		normalized.length === 0 ||
		normalized.length > 253 ||
		normalized.includes('://') ||
		/[/\\@\s]/.test(normalized) ||
		normalized.includes(':')
	) {
		throw new EmailMcpError('CONFIG_INVALID', 'Mail server host must be a bare hostname without scheme, port, or path');
	}
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized)) {
		throw new EmailMcpError('CONFIG_INVALID', 'Mail server host contains invalid characters');
	}
	if (BLOCKED_METADATA_HOSTS.has(normalized)) {
		throw new EmailMcpError('SECURITY_BLOCKED', 'Cloud metadata endpoints are not allowed as mail server hosts');
	}
	if (net.isIP(normalized) !== 0 && isPrivateIp(normalized) && !allowPrivateHosts) {
		throw new EmailMcpError(
			'SECURITY_BLOCKED',
			'Private or loopback mail server addresses require EMAIL_ALLOW_PRIVATE_HOSTS=true',
		);
	}
	return normalized;
}

export function assertResolvedAddressesAllowed(addresses: readonly string[], allowPrivateHosts: boolean): void {
	for (const address of addresses) {
		if (isPrivateIp(address) && !allowPrivateHosts) {
			throw new EmailMcpError(
				'SECURITY_BLOCKED',
				'Mail server resolves to a private or loopback address; set EMAIL_ALLOW_PRIVATE_HOSTS=true only for trusted local development',
			);
		}
	}
}

export function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
