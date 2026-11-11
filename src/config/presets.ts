import type { EndpointConfig, VerificationStatus } from '../core/types.js';

export interface ProviderPreset {
  id: string;
  label: string;
  imap: EndpointConfig;
  smtp: EndpointConfig;
  /** Consumer providers require an app-specific password / authorization code. */
  requiresAppPassword: boolean;
  status: VerificationStatus;
  notes: string;
}

function endpoint(host: string, port: number, secure = true): EndpointConfig {
  return { host, port, secure, requireTls: true };
}

/**
 * Presets are data only. None of these providers are marked as verified until a
 * maintainer has actually completed a live integration test and updated the
 * compatibility matrix. Simulated tests do not count as verification.
 */
export const PROVIDER_PRESETS: Readonly<Record<string, ProviderPreset>> = Object.freeze({
  'netease-enterprise': {
    id: 'netease-enterprise',
    label: 'NetEase Enterprise Mail (qiye.163.com)',
    imap: endpoint('imap.qiye.163.com', 993),
    smtp: endpoint('smtp.qiye.163.com', 465),
    requiresAppPassword: false,
    status: 'documented',
    notes:
      'Documented IMAP/SMTP endpoints. Some tenants require enabling IMAP/SMTP and a client-specific password in the admin console.',
  },
  'alibaba-enterprise': {
    id: 'alibaba-enterprise',
    label: 'Alibaba Enterprise Mail (qiye.aliyun.com)',
    imap: endpoint('imap.qiye.aliyun.com', 993),
    smtp: endpoint('smtp.qiye.aliyun.com', 465),
    requiresAppPassword: false,
    status: 'documented',
    notes: 'Documented IMAP/SMTP endpoints. Tenant security policies may require a client-specific password.',
  },
  'tencent-enterprise': {
    id: 'tencent-enterprise',
    label: 'Tencent Exmail (exmail.qq.com)',
    imap: endpoint('imap.exmail.qq.com', 993),
    smtp: endpoint('smtp.exmail.qq.com', 465),
    requiresAppPassword: false,
    status: 'documented',
    notes: 'Documented IMAP/SMTP endpoints. Admins may need to enable IMAP/SMTP for the account.',
  },
  qq: {
    id: 'qq',
    label: 'QQ Mail',
    imap: endpoint('imap.qq.com', 993),
    smtp: endpoint('smtp.qq.com', 465),
    requiresAppPassword: true,
    status: 'documented',
    notes: 'Requires an authorization code (app password), not the normal account password.',
  },
  'netease-163': {
    id: 'netease-163',
    label: '163 Mail',
    imap: endpoint('imap.163.com', 993),
    smtp: endpoint('smtp.163.com', 465),
    requiresAppPassword: true,
    status: 'documented',
    notes: 'Requires enabling IMAP/SMTP and an authorization code (app password).',
  },
  'netease-126': {
    id: 'netease-126',
    label: '126 Mail',
    imap: endpoint('imap.126.com', 993),
    smtp: endpoint('smtp.126.com', 465),
    requiresAppPassword: true,
    status: 'documented',
    notes: 'Requires enabling IMAP/SMTP and an authorization code (app password).',
  },
  custom: {
    id: 'custom',
    label: 'Custom IMAP/SMTP server',
    imap: endpoint('imap.invalid', 993),
    smtp: endpoint('smtp.invalid', 465),
    requiresAppPassword: false,
    status: 'configured',
    notes: 'Placeholder preset only. Specify explicit IMAP and SMTP endpoints; never use these placeholder hosts.',
  },
});

export function getPreset(id: string): ProviderPreset | undefined {
  return Object.prototype.hasOwnProperty.call(PROVIDER_PRESETS, id) ? PROVIDER_PRESETS[id] : undefined;
}

export interface PublicPreset {
  preset_id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  requires_app_password: boolean;
  verification_status: VerificationStatus;
  notes: string;
}

export function listPublicPresets(): PublicPreset[] {
  return Object.values(PROVIDER_PRESETS)
    .filter((preset) => preset.id !== 'custom')
    .map((preset) => ({
      preset_id: preset.id,
      label: preset.label,
      imap_host: preset.imap.host,
      imap_port: preset.imap.port,
      smtp_host: preset.smtp.host,
      smtp_port: preset.smtp.port,
      requires_app_password: preset.requiresAppPassword,
      verification_status: preset.status,
      notes: preset.notes,
    }));
}
