import type { AuditEntry, AuditQueryFilter, AuditQueryResult } from "../types.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// shared by both store impls so they can't drift apart
export function filterEntries(
  allEntries: readonly AuditEntry[],
  filter: AuditQueryFilter,
): AuditQueryResult {
  const limit = Math.min(Math.max(filter.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

  // newest first. timestamps are only ms precision so ties happen easily when
  // calls fire back to back - break ties by actual write order (index), not
  // by id, since ids are random uuids and that scrambles ties on every call
  const sorted = allEntries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const byTime = b.entry.timestamp.localeCompare(a.entry.timestamp);
      return byTime !== 0 ? byTime : b.index - a.index;
    })
    .map(({ entry }) => entry);

  let filtered = sorted.filter((e) => {
    if (filter.actorId && e.actor.id !== filter.actorId) return false;
    if (filter.actorType && e.actor.type !== filter.actorType) return false;
    if (filter.action && e.action !== filter.action) return false;
    if (filter.targetId && e.target.id !== filter.targetId) return false;
    if (filter.targetType && e.target.type !== filter.targetType) return false;
    if (filter.decision && e.decision !== filter.decision) return false;
    if (filter.from && e.timestamp < filter.from) return false;
    if (filter.to && e.timestamp > filter.to) return false;
    return true;
  });

  if (filter.cursor) {
    const cursorIndex = filtered.findIndex((e) => e.id === filter.cursor);
    filtered = cursorIndex >= 0 ? filtered.slice(cursorIndex + 1) : filtered;
  }

  const page = filtered.slice(0, limit);
  const nextCursor = filtered.length > limit ? page[page.length - 1]!.id : null;

  return { entries: page, nextCursor };
}
