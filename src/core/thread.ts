import { LIMITS } from './limits.js';
import type { MessageSummary, ThreadResult } from './types.js';

export interface ThreadCandidate {
  summary: MessageSummary;
  messageIdHeader: string | null;
  inReplyTo: string | null;
  references: string[];
}

export function normalizeSubject(subject: string): string {
  let normalized = subject.trim();
  const prefix = /^(?:(?:re|fw|fwd|aw|sv|回复|答复|转发)\s*[:：]\s*)/i;
  let previous = '';
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(prefix, '').trim();
  }
  return normalized.toLowerCase();
}

function hoursApart(a: string | null, b: string | null, maxHours: number): boolean {
  if (a === null || b === null) {
    return false;
  }
  const first = Date.parse(a);
  const second = Date.parse(b);
  if (Number.isNaN(first) || Number.isNaN(second)) {
    return false;
  }
  return Math.abs(first - second) <= maxHours * 60 * 60 * 1000;
}

function collectReferenceIds(candidate: ThreadCandidate): Set<string> {
  const ids = new Set<string>();
  if (candidate.messageIdHeader !== null) {
    ids.add(candidate.messageIdHeader);
  }
  if (candidate.inReplyTo !== null) {
    ids.add(candidate.inReplyTo);
  }
  for (const reference of candidate.references) {
    ids.add(reference);
  }
  return ids;
}

/**
 * Best-effort thread reconstruction from Message-ID / In-Reply-To / References.
 * Falls back to normalized subject + date proximity when no header links exist.
 * Standard IMAP does not provide a guaranteed thread identifier, so `complete`
 * is always false.
 */
export function buildThread(
  seed: ThreadCandidate,
  candidates: readonly ThreadCandidate[],
  limit: number = LIMITS.maxThreadMessages,
): ThreadResult {
  const warnings: string[] = [];
  const pool = [seed, ...candidates.filter((candidate) => candidate.summary.messageId !== seed.summary.messageId)];
  const byId = new Map<string, number>();
  pool.forEach((candidate, index) => {
    if (candidate.messageIdHeader !== null) {
      byId.set(candidate.messageIdHeader.toLowerCase(), index);
    }
  });

  const adjacency = new Map<number, Set<number>>();
  const link = (a: number, b: number): void => {
    if (a === b) {
      return;
    }
    const first = adjacency.get(a) ?? new Set<number>();
    first.add(b);
    adjacency.set(a, first);
    const second = adjacency.get(b) ?? new Set<number>();
    second.add(a);
    adjacency.set(b, second);
  };

  pool.forEach((candidate, index) => {
    const ids = collectReferenceIds(candidate);
    for (const id of ids) {
      const target = byId.get(id.toLowerCase());
      if (target !== undefined) {
        link(index, target);
      }
    }
  });

  const seedIndex = 0;
  const visited = new Set<number>([seedIndex]);
  const queue = [seedIndex];
  while (queue.length > 0) {
    const index = queue.shift() as number;
    for (const neighbour of adjacency.get(index) ?? []) {
      if (!visited.has(neighbour)) {
        visited.add(neighbour);
        queue.push(neighbour);
      }
    }
  }

  let method: ThreadResult['method'] = visited.size > 1 ? 'references' : 'none';
  if (visited.size === 1) {
    const seedSubject = normalizeSubject(seed.summary.subject);
    if (seedSubject.length > 0) {
      pool.forEach((candidate, index) => {
        if (index === seedIndex || visited.has(index)) {
          return;
        }
        if (
          normalizeSubject(candidate.summary.subject) === seedSubject &&
          hoursApart(seed.summary.date, candidate.summary.date, 30 * 24)
        ) {
          visited.add(index);
        }
      });
      if (visited.size > 1) {
        method = 'subject';
        warnings.push('thread_grouped_by_subject_fallback');
      }
    }
  }

  if (visited.size === 1 && pool.length > 1) {
    warnings.push('thread_links_not_found');
  }

  const selected = [...visited]
    .map((index) => pool[index])
    .filter((candidate): candidate is ThreadCandidate => candidate !== undefined)
    .sort((a, b) => {
      const first = a.summary.date === null ? 0 : Date.parse(a.summary.date);
      const second = b.summary.date === null ? 0 : Date.parse(b.summary.date);
      return first - second;
    });

  if (selected.length > limit) {
    selected.splice(0, selected.length - limit);
    warnings.push('thread_truncated_to_limit');
  }

  return {
    threadId: seed.messageIdHeader ?? seed.summary.messageId,
    messages: selected.map((candidate) => candidate.summary),
    method,
    complete: false,
    warnings,
  };
}
