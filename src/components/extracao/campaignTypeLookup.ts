/**
 * T-022 — Lookup visual de campaign_type / source para a aba "Disparos".
 *
 * Cada tipo conhecido vira { label PT, icon emoji, color tailwind }.
 * Tipos não mapeados caem no fallback "✉️ {campaign_type}" cinza.
 *
 * Centralizado num único arquivo para que DispatchMonitor, dashboard e
 * qualquer futura listagem (ex: relatórios CSV) compartilhem a mesma
 * tradução visual.
 */

export interface CampaignTypeMeta {
  label: string;
  icon: string;
  /** Classes Tailwind aplicadas no Badge (text + border + bg). */
  badgeClass: string;
}

const CAMPAIGN_TYPE_MAP: Record<string, CampaignTypeMeta> = {
  birthday: {
    label: 'Aniversário',
    icon: '🎂',
    badgeClass:
      'text-pink-700 border-pink-200 bg-pink-50 dark:text-pink-300 dark:border-pink-900 dark:bg-pink-950/30',
  },
  renewal: {
    label: 'Renovação',
    icon: '🔄',
    badgeClass:
      'text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-300 dark:border-blue-900 dark:bg-blue-950/30',
  },
  overdue: {
    label: 'Cobrança',
    icon: '💰',
    badgeClass:
      'text-amber-700 border-amber-200 bg-amber-50 dark:text-amber-300 dark:border-amber-900 dark:bg-amber-950/30',
  },
  winback: {
    label: 'Reativação',
    icon: '💪',
    badgeClass:
      'text-purple-700 border-purple-200 bg-purple-50 dark:text-purple-300 dark:border-purple-900 dark:bg-purple-950/30',
  },
  promo: {
    label: 'Promoção',
    icon: '🎁',
    badgeClass:
      'text-emerald-700 border-emerald-200 bg-emerald-50 dark:text-emerald-300 dark:border-emerald-900 dark:bg-emerald-950/30',
  },
};

const CAMPAIGN_TYPE_FALLBACK_BADGE =
  'text-muted-foreground border-muted bg-muted/30';

/** Devolve metadata visual pro campaign_type (case-insensitive). */
export function getCampaignTypeMeta(campaignType: string | null | undefined): CampaignTypeMeta {
  if (!campaignType) {
    return {
      label: '—',
      icon: '✉️',
      badgeClass: CAMPAIGN_TYPE_FALLBACK_BADGE,
    };
  }
  const key = campaignType.trim().toLowerCase();
  const mapped = CAMPAIGN_TYPE_MAP[key];
  if (mapped) return mapped;
  return {
    label: campaignType,
    icon: '✉️',
    badgeClass: CAMPAIGN_TYPE_FALLBACK_BADGE,
  };
}

/* ============================================================
 * Source visual mapping
 * ============================================================ */

export interface SourceMeta {
  label: string;
  /** Variant do shadcn Badge — usado quando não há classe custom. */
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
  /** Classes extras (cores) — empilhadas com o variant. */
  badgeClass?: string;
}

const SOURCE_MAP: Record<string, SourceMeta> = {
  manual: {
    label: 'Manual',
    variant: 'outline',
    badgeClass:
      'text-muted-foreground border-muted-foreground/30',
  },
  manual_scheduled: {
    label: 'Agendado',
    variant: 'outline',
    badgeClass:
      'text-blue-700 border-blue-200 bg-blue-50 dark:text-blue-300 dark:border-blue-900 dark:bg-blue-950/30',
  },
  n8n: {
    label: 'n8n',
    variant: 'outline',
    badgeClass:
      'text-purple-700 border-purple-200 bg-purple-50 dark:text-purple-300 dark:border-purple-900 dark:bg-purple-950/30',
  },
  api: {
    label: 'API',
    variant: 'outline',
    badgeClass:
      'text-green-700 border-green-200 bg-green-50 dark:text-green-300 dark:border-green-900 dark:bg-green-950/30',
  },
  integration: {
    label: 'Integração',
    variant: 'outline',
    badgeClass:
      'text-orange-700 border-orange-200 bg-orange-50 dark:text-orange-300 dark:border-orange-900 dark:bg-orange-950/30',
  },
};

export function getSourceMeta(source: string | null | undefined): SourceMeta {
  if (!source) {
    return { label: '—', variant: 'outline' };
  }
  const key = source.trim().toLowerCase();
  return (
    SOURCE_MAP[key] ?? {
      label: source,
      variant: 'outline',
    }
  );
}

/**
 * Extrai campaign_type da metadata JSON do batch (case-insensitive na chave).
 * Aceita tanto `metadata.campaign_type` quanto `metadata.campaignType`.
 */
export function extractCampaignType(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const direct = (metadata as Record<string, unknown>).campaign_type ?? (metadata as Record<string, unknown>).campaignType;
  return typeof direct === 'string' && direct.length > 0 ? direct : null;
}
