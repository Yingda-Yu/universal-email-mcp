import { describe, expect, it } from 'vitest';
import { buildThread, normalizeSubject, type ThreadCandidate } from '../../src/core/thread.js';
import type { MessageSummary } from '../../src/core/types.js';

function summary(overrides: Partial<MessageSummary> & { messageId: string }): MessageSummary {
  return {
    messageId: overrides.messageId,
    folder: overrides.folder ?? 'INBOX',
    uid: overrides.uid ?? 1,
    uidValidity: overrides.uidValidity ?? '1',
    subject: overrides.subject ?? 'Subject',
    from: overrides.from ?? [{ address: 'sender@example.com' }],
    to: overrides.to ?? [{ address: 'recipient@example.com' }],
    date: overrides.date ?? '2026-11-01T10:00:00.000Z',
    snippet: overrides.snippet ?? '',
    unread: overrides.unread ?? false,
    hasAttachments: overrides.hasAttachments ?? false,
  };
}

function candidate(
  id: string,
  messageIdHeader: string | null,
  inReplyTo: string | null,
  references: string[],
  overrides: Partial<MessageSummary> = {},
): ThreadCandidate {
  return {
    summary: summary({ messageId: `mock1.${id}`, ...overrides }),
    messageIdHeader,
    inReplyTo,
    references,
  };
}

describe('normalizeSubject', () => {
  it('removes nested reply and forward prefixes', () => {
    expect(normalizeSubject('Re: Fwd: Project kickoff')).toBe('project kickoff');
    expect(normalizeSubject('回复： 项目启动')).toBe('项目启动');
  });
});

describe('buildThread', () => {
  it('links messages through References and In-Reply-To headers', () => {
    const seed = candidate('seed', '<reply@example.com>', '<root@example.com>', ['<root@example.com>'], {
      subject: 'Re: Project kickoff',
      date: '2026-11-02T10:00:00.000Z',
    });
    const root = candidate('root', '<root@example.com>', null, [], {
      subject: 'Project kickoff',
      date: '2026-11-02T09:00:00.000Z',
    });
    const unrelated = candidate('unrelated', '<other@example.com>', null, [], {
      subject: 'Unrelated message',
      date: '2026-11-02T11:00:00.000Z',
    });

    const result = buildThread(seed, [root, unrelated]);
    expect(result.method).toBe('references');
    expect(result.complete).toBe(false);
    expect(result.messages.map((message) => message.messageId)).toEqual([
      'mock1.root',
      'mock1.seed',
    ]);
  });

  it('falls back to normalized subjects with date proximity', () => {
    const seed = candidate('seed', null, null, [], {
      subject: 'Re: Weekly sync',
      date: '2026-11-02T10:00:00.000Z',
    });
    const reply = candidate('reply', null, null, [], {
      subject: 'Re: Weekly sync',
      date: '2026-11-02T11:00:00.000Z',
    });

    const result = buildThread(seed, [reply]);
    expect(result.method).toBe('subject');
    expect(result.messages).toHaveLength(2);
    expect(result.warnings).toContain('thread_grouped_by_subject_fallback');
    expect(result.complete).toBe(false);
  });

  it('reports when no links are found', () => {
    const seed = candidate('seed', '<seed@example.com>', null, [], { subject: 'Alpha' });
    const other = candidate('other', '<other@example.com>', null, [], {
      subject: 'Beta',
      date: '2026-11-05T10:00:00.000Z',
    });

    const result = buildThread(seed, [other]);
    expect(result.method).toBe('none');
    expect(result.messages).toHaveLength(1);
    expect(result.warnings).toContain('thread_links_not_found');
  });

  it('truncates to the requested limit and warns', () => {
    const seed = candidate('seed', '<seed@example.com>', null, [], {
      subject: 'Thread',
      date: '2026-11-01T00:00:00.000Z',
    });
    const candidates = [1, 2, 3].map((index) =>
      candidate(`m${index}`, `<m${index}@example.com>`, '<seed@example.com>', [], {
        subject: 'Thread',
        date: `2026-11-0${index + 1}T00:00:00.000Z`,
      }),
    );

    const result = buildThread(seed, candidates, 2);
    expect(result.messages).toHaveLength(2);
    expect(result.warnings).toContain('thread_truncated_to_limit');
  });
});
