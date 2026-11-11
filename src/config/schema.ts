import { z } from 'zod';
import { LIMITS } from '../core/limits.js';
import { isValidEmailAddress } from '../core/validate.js';

export const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DRAFT_ID_PATTERN = /^drft_[a-f0-9]{24}$/;

const endpointSchema = z
  .object({
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean().default(true),
    requireTls: z.boolean().default(true),
  })
  .strict();

const accountSchema = z
  .object({
    id: z.string().regex(ACCOUNT_ID_PATTERN, 'account id must match ^[a-z0-9][a-z0-9_-]{0,63}$'),
    label: z.string().min(1).max(100),
    email: z
      .string()
      .min(3)
      .max(320)
      .refine((value) => isValidEmailAddress(value), 'email must be a valid email address'),
    provider: z.enum(['imap-smtp', 'mock', 'gmail', 'graph']).default('imap-smtp'),
    preset: z.string().min(1).max(64).optional(),
    username: z.string().min(1).max(320).optional(),
    password: z.string().min(1).max(1024).optional(),
    passwordEnv: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{1,127}$/, 'passwordEnv must be an environment variable name')
      .optional(),
    imap: endpointSchema.optional(),
    smtp: endpointSchema.optional(),
    enabled: z.boolean().default(true),
    send: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({ enabled: false }),
    mock: z
      .object({
        fixture: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.password !== undefined && value.passwordEnv !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'Use either password or passwordEnv, not both',
      });
    }
    if (value.provider === 'imap-smtp' && value.username === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['username'],
        message: 'username is required for IMAP/SMTP accounts',
      });
    }
    if (value.provider !== 'imap-smtp' && (value.imap !== undefined || value.smtp !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imap'],
        message: 'IMAP/SMTP endpoints are only valid when provider is imap-smtp',
      });
    }
    if (value.provider !== 'imap-smtp' && value.preset !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preset'],
        message: 'presets only apply to provider imap-smtp',
      });
    }
    if (value.provider === 'mock' && (value.password !== undefined || value.passwordEnv !== undefined)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['password'],
        message: 'mock accounts must not contain credentials',
      });
    }
  });

export const configFileSchema = z
  .object({
    version: z.literal(1).default(1),
    accounts: z.array(accountSchema).min(1).max(LIMITS.maxAccounts),
  })
  .strict();

export type RawConfigFile = z.infer<typeof configFileSchema>;
export type RawAccountConfig = z.infer<typeof accountSchema>;

export interface SafeIssue {
  path: string;
  code: string;
  message: string;
}

/**
 * Formats validation issues without echoing input values, which may contain
 * passwords or other secrets.
 */
export function formatZodIssues(error: z.ZodError): SafeIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
}
