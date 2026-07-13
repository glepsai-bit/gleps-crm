/**
 * TRACKING SERVICE — inteligência de rastreamento Meta Ads / CTWA.
 *
 * Responsabilidades:
 *  - Config por conta (token + pixel + ad account + toggles de evento).
 *  - Registrar e enviar eventos de conversão (Lead/Schedule/Purchase) via
 *    Conversions API, sempre com o ctwa_clid da conversa de origem.
 *  - Funil de métricas: gasto (Marketing API) × conversas × reuniões ×
 *    vendas, total e por anúncio.
 *
 * Todos os envios são best-effort: registrar/enviar tracking NUNCA pode
 * quebrar o fluxo principal (webhook, agenda, venda).
 */
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { metaCapiService } from './meta-capi.service';
import { ValidationError } from '../utils/errors';

export type TrackingEventName = 'Lead' | 'Schedule' | 'Purchase';

export interface AdAgg {
  adId: string;
  adName: string;
  campaignName: string;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
}

export interface TrackingConfigInput {
  accessToken?: string | null;
  pixelId?: string | null;
  adAccountId?: string | null;
  active?: boolean;
  sendLead?: boolean;
  sendSchedule?: boolean;
  sendPurchase?: boolean;
}

export interface RecordEventInput {
  accountId: string;
  eventName: TrackingEventName;
  ctwaClid: string;
  conversationId?: string | null;
  contactId?: string | null;
  value?: number | null;
  currency?: string | null;
}

const EVENT_TOGGLE: Record<TrackingEventName, 'sendLead' | 'sendSchedule' | 'sendPurchase'> = {
  Lead: 'sendLead',
  Schedule: 'sendSchedule',
  Purchase: 'sendPurchase',
};

class TrackingService {
  // ============================================
  // Config
  // ============================================

  async getConfig(accountId: string) {
    return prisma.trackingConfig.findUnique({ where: { accountId } });
  }

  async saveConfig(accountId: string, input: TrackingConfigInput) {
    const data: Record<string, unknown> = {};
    if (input.accessToken !== undefined) data.accessToken = input.accessToken || null;
    if (input.pixelId !== undefined) data.pixelId = input.pixelId || null;
    if (input.adAccountId !== undefined) data.adAccountId = input.adAccountId || null;
    if (input.active !== undefined) data.active = input.active;
    if (input.sendLead !== undefined) data.sendLead = input.sendLead;
    if (input.sendSchedule !== undefined) data.sendSchedule = input.sendSchedule;
    if (input.sendPurchase !== undefined) data.sendPurchase = input.sendPurchase;

    const saved = await prisma.trackingConfig.upsert({
      where: { accountId },
      create: { accountId, ...data },
      update: data,
    });

    if (saved.active && (!saved.accessToken || !saved.pixelId)) {
      throw new ValidationError(
        'Para ativar o tracking é preciso informar o token de acesso e o ID do pixel/dataset.'
      );
    }
    return saved;
  }

  // ============================================
  // Eventos de conversão
  // ============================================

  /**
   * Registra o evento no log e envia pra Meta (CAPI). NUNCA lança — o
   * chamador está sempre num fluxo principal (webhook/agenda/venda).
   */
  async recordConversionEvent(input: RecordEventInput): Promise<void> {
    try {
      const config = await this.getConfig(input.accountId);
      if (!config || !config.active) return;
      if (!config[EVENT_TOGGLE[input.eventName]]) return;
      if (!config.accessToken || !config.pixelId) return;
      if (!input.ctwaClid) return;

      const row = await prisma.trackingEvent.create({
        data: {
          accountId: input.accountId,
          conversationId: input.conversationId ?? null,
          contactId: input.contactId ?? null,
          eventName: input.eventName,
          ctwaClid: input.ctwaClid,
          value: input.value ?? null,
          currency: input.currency ?? (input.value != null ? 'BRL' : null),
          status: 'pending',
        },
      });

      try {
        await metaCapiService.sendEvent(
          { accessToken: config.accessToken, pixelId: config.pixelId },
          {
            eventName: input.eventName,
            ctwaClid: input.ctwaClid,
            eventTime: Math.floor(Date.now() / 1000),
            value: input.value ?? undefined,
            currency: input.currency ?? undefined,
          }
        );
        await prisma.trackingEvent.update({
          where: { id: row.id },
          data: { status: 'sent', sentAt: new Date(), error: null },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await prisma.trackingEvent.update({
          where: { id: row.id },
          data: { status: 'failed', error: msg.slice(0, 500) },
        });
        logger.warn('[tracking] envio CAPI falhou', {
          accountId: input.accountId,
          eventName: input.eventName,
          error: msg,
        });
      }
    } catch (err) {
      logger.warn('[tracking] recordConversionEvent falhou', {
        accountId: input.accountId,
        eventName: input.eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Resolve o ctwa_clid mais recente de um contato (conversa de anúncio).
   * null = contato não veio de anúncio rastreado.
   */
  async resolveCtwaForContact(
    accountId: string,
    contactId: string
  ): Promise<{ ctwaClid: string; conversationId: string } | null> {
    const conv = await prisma.conversation.findFirst({
      where: { accountId, contactId, ctwaClid: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, ctwaClid: true },
    });
    if (!conv?.ctwaClid) return null;
    return { ctwaClid: conv.ctwaClid, conversationId: conv.id };
  }

  // ============================================
  // Funil de métricas
  // ============================================

  async getFunnel(accountId: string, from: Date, to: Date) {
    const config = await this.getConfig(accountId);

    const convWhere = { accountId, createdAt: { gte: from, lte: to } };

    const [ctwaConversations, organicConversations, eventGroups, ctwaConvRows] =
      await Promise.all([
        prisma.conversation.count({ where: { ...convWhere, sourceType: 'ctwa' } }),
        prisma.conversation.count({
          where: { ...convWhere, sourceType: { not: 'ctwa' } },
        }),
        prisma.trackingEvent.groupBy({
          by: ['eventName'],
          where: {
            accountId,
            createdAt: { gte: from, lte: to },
            status: { in: ['sent', 'pending', 'failed'] },
          },
          _count: { _all: true },
          _sum: { value: true },
        }),
        // Conversas de anúncio do período com o anúncio de origem — base do
        // quebra-por-anúncio (payload pequeno: só ids e rótulos).
        prisma.conversation.findMany({
          where: { ...convWhere, sourceType: 'ctwa' },
          select: { id: true, adSourceId: true, adHeadline: true },
        }),
      ]);

    const byName = new Map(eventGroups.map((g) => [g.eventName, g]));
    const meetings = byName.get('Schedule')?._count._all ?? 0;
    const purchases = byName.get('Purchase')?._count._all ?? 0;
    const revenue = Number(byName.get('Purchase')?._sum.value ?? 0);

    // Eventos do período ligados a conversas (para atribuir por anúncio)
    const events = await prisma.trackingEvent.findMany({
      where: {
        accountId,
        createdAt: { gte: from, lte: to },
        conversationId: { not: null },
        eventName: { in: ['Schedule', 'Purchase'] },
      },
      select: { eventName: true, conversationId: true, value: true },
    });

    // Spend por anúncio via Marketing API (best-effort, [] se indisponível)
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const spendRows =
      config?.active && config.accessToken && config.adAccountId
        ? await metaCapiService.getAdSpend(
            config.accessToken,
            config.adAccountId,
            fmt(from),
            fmt(to)
          )
        : [];
    const totalSpend = spendRows.reduce((acc, r) => acc + r.spend, 0);

    // Join em memória: conversa → anúncio; eventos → conversa → anúncio.
    const convToAd = new Map(ctwaConvRows.map((c) => [c.id, c.adSourceId ?? '']));
    const byAd = new Map<string, AdAgg>();
    const ensureAd = (adId: string): AdAgg => {
      let agg = byAd.get(adId);
      if (!agg) {
        agg = {
          adId,
          adName: '',
          campaignName: '',
          spend: 0,
          conversations: 0,
          meetings: 0,
          purchases: 0,
          revenue: 0,
        };
        byAd.set(adId, agg);
      }
      return agg;
    };
    for (const row of spendRows) {
      const agg = ensureAd(row.adId);
      agg.adName = row.adName;
      agg.campaignName = row.campaignName;
      agg.spend += row.spend;
    }
    for (const c of ctwaConvRows) {
      const agg = ensureAd(c.adSourceId ?? '');
      agg.conversations += 1;
      if (!agg.adName && c.adHeadline) agg.adName = c.adHeadline;
    }
    for (const ev of events) {
      const adId = convToAd.get(ev.conversationId as string);
      if (adId === undefined) continue;
      const agg = ensureAd(adId);
      if (ev.eventName === 'Schedule') agg.meetings += 1;
      if (ev.eventName === 'Purchase') {
        agg.purchases += 1;
        agg.revenue += Number(ev.value ?? 0);
      }
    }

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      connected: Boolean(config?.active),
      spendAvailable: spendRows.length > 0,
      totals: {
        spend: totalSpend,
        ctwaConversations,
        organicConversations,
        meetings,
        purchases,
        revenue,
        costPerConversation:
          ctwaConversations > 0 ? totalSpend / ctwaConversations : null,
        costPerMeeting: meetings > 0 ? totalSpend / meetings : null,
        costPerPurchase: purchases > 0 ? totalSpend / purchases : null,
      },
      byAd: Array.from(byAd.values()).sort((a, b) => b.spend - a.spend),
    };
  }

  /** Últimos eventos enviados (auditoria na tela). */
  async listRecentEvents(accountId: string, limit = 50) {
    return prisma.trackingEvent.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }
}

export const trackingService = new TrackingService();
