export interface StageTagCandidate {
  id: string;
  slug: string;
  name: string;
}

export function normalizeStageKey(value: unknown): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function extractLabelValue(label: unknown): string {
  if (typeof label === 'string') return label;
  if (label && typeof label === 'object') {
    const record = label as Record<string, unknown>;
    return String(record.title || record.name || record.slug || '');
  }
  return '';
}

export function resolveLatestStageTagFromLabels<T extends StageTagCandidate>(
  labels: unknown[],
  stageTags: T[]
): {
  tag: T | null;
  label: string | null;
  normalizedKey: string | null;
  matchCount: number;
} {
  let resolvedTag: T | null = null;
  let resolvedLabel: string | null = null;
  let resolvedKey: string | null = null;
  let matchCount = 0;

  for (const rawLabel of labels) {
    const label = extractLabelValue(rawLabel);
    const labelKey = normalizeStageKey(label);
    if (!labelKey) continue;

    const matchedTag = stageTags.find((tag) => {
      const candidates = [tag.slug, tag.name]
        .map((candidate) => normalizeStageKey(candidate))
        .filter(Boolean);

      return candidates.includes(labelKey);
    });

    if (!matchedTag) continue;

    resolvedTag = matchedTag;
    resolvedLabel = label;
    resolvedKey = labelKey;
    matchCount += 1;
  }

  return {
    tag: resolvedTag,
    label: resolvedLabel,
    normalizedKey: resolvedKey,
    matchCount,
  };
}