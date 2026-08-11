/**
 * TRACKING SERVICE — inteligência de rastreamento Meta Ads / CTWA.
 *
 * Responsabilidades:
 *  - Config por conta (token + pixel + ad account + toggles de evento).
 *  - Registrar e enviar eventos de conversão (Lead/Schedule/Purchase) via
 *    Conversions API, sempre com o ctwa_clid da conversa de origem.
 *  - Funil de métricas: gasto (Marketing API) × conversas × reuniões ×
 *    vendas, total, por campanha, por anúncio e por dia.
 *  - CONGRUÊNCIA: comparar o que aconteceu no CRM com o que a Meta
 *    efetivamente recebeu, e reconciliar a diferença (backfill).
 *
 * Todos os envios do fluxo normal são best-effort: registrar/enviar tracking
 * NUNCA pode quebrar o fluxo principal (webhook, agenda, venda). Já a
 * reconciliação é uma ação explícita do usuário e reporta erro de verdade.
 */
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import {
  metaCapiService,
  CAPI_MAX_EVENT_AGE_DAYS,
  type ConnectionCheck,
} from './meta-capi.service';
import { ValidationError } from '../utils/errors';

export type TrackingEventName = 'Lead' | 'Schedule' | 'Purchase';
export type TrackingSourceType = 'conversation' | 'calendar_event' | 'sale';

/** Dia no fuso do negócio — alinhado com o resto do produto (SLA, agenda). */
const DAY_TZ = 'America/Sao_Paulo';
const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const dayKey = (d: Date): string => dayFormatter.format(d);

/**
 * Teto de envios por execução. Dimensionado para caber no timeout do proxy
 * (nginx corta em 120s): sobrando trabalho, o relatório volta com capped=true
 * e a tela instrui rodar de novo — melhor que um 504 sem relatório nenhum.
 */
const RECONCILE_MAX_SENDS = 50;

/** Conversa de anúncio de um contato, com a data para o corte temporal. */
interface CtwaHit {
  conversationId: string;
  ctwaClid: string;
  adSourceId: string;
  createdAt: Date;
}

/**
 * Conversa de anúncio mais recente ANTERIOR ao fato (a lista já vem desc, o
 * primeiro match vence).
 *
 * Sem este corte a reconciliação credita uma reunião/venda a um clique que
 * ainda nem tinha acontecido: no fluxo ao vivo isso é impossível (o evento
 * dispara no instante do fato), mas o backfill roda depois e enxergaria
 * cliques futuros. Seria uma conversão fabricada — não uma duplicata.
 */
const ctwaBefore = (list: CtwaHit[] | undefined, at: Date): CtwaHit | undefined =>
  list?.find((c) => c.createdAt.getTime() <= at.getTime());

export interface AdAgg {
  adId: string;
  adName: string;
  campaignId: string;
  campaignName: string;
  spend: number;
  impressions: number;
  linkClicks: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
  costPerConversation: number | null;
  roas: number | null;
}

export interface CampaignAgg {
  campaignId: string;
  campaignName: string;
  ads: number;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
  costPerConversation: number | null;
  roas: number | null;
}

export interface FunnelDailyPoint {
  date: string;
  spend: number;
  conversations: number;
  meetings: number;
  purchases: number;
  revenue: number;
}

/** O que a Meta REALMENTE recebeu, por evento. */
export interface DeliveryStat {
  eventName: TrackingEventName;
  sent: number;
  pending: number;
  failed: number;
  skipped: number;
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
  sourceType?: TrackingSourceType;
  sourceId?: string | null;
  /** Momento real do fato. Default = agora. Usado no backfill. */
  occurredAt?: Date;
}

export interface ReconcileGap {
  eventName: TrackingEventName;
  sourceType: TrackingSourceType;
  sourceId: string;
  conversationId: string;
  contactId: string | null;
  ctwaClid: string;
  occurredAt: Date;
  value: number | null;
  label: string;
  /** false = mais velho que a janela da CAPI; não há como recuperar. */
  recoverable: boolean;
}

export interface ReconcileReport {
  dryRun: boolean;
  window: { from: string; to: string };
  gaps: { Lead: number; Schedule: number; Purchase: number; total: number };
  recoverable: number;
  outOfWindow: number;
  sent: number;
  failed: number;
  skipped: number;
  retriedFailed: number;
  retriedOk: number;
  capped: boolean;
  samples: Array<{
    eventName: TrackingEventName;
    label: string;
    occurredAt: string;
    recoverable: boolean;
  }>;
}

type DispatchOutcome = 'sent' | 'failed' | 'duplicate' | 'out_of_window' | 'disabled';

const EVENT_TOGGLE: Record<TrackingEventName, 'sendLead' | 'sendSchedule' | 'sendPurchase'> = {
  Lead: 'sendLead',
  Schedule: 'sendSchedule',
  Purchase: 'sendPurchase',
};

type ConfigRow = NonNullable<Awaited<ReturnType<typeof prisma.trackingConfig.findUnique>>>;

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
    if (input.pixelId !== undefined) data.pixelId = input.pixelId?.trim() || null;
    if (input.adAccountId !== undefined) data.adAccountId = input.adAccountId?.trim() || null;
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

  /** Diagnóstico da conexão: testa cada ativo e diz o motivo real da falha. */
  async verifyConnection(accountId: string, days = 7): Promise<ConnectionCheck[]> {
    const config = await this.getConfig(accountId);
    if (!config?.accessToken) {
      return [
        {
          key: 'pixel',
          label: 'Token de acesso',
          ok: false,
          detail: 'Nenhum token salvo nesta conta.',
          hint: 'Gere um token de usuário do sistema na Business Manager e salve aqui.',
        },
      ];
    }
    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    return metaCapiService.checkConnection(
      config.accessToken,
      config.pixelId,
      config.adAccountId,
      { since: from.toISOString().slice(0, 10), until: to.toISOString().slice(0, 10) }
    );
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
      if (!config) return;
      await this.dispatchEvent(config, input);
    } catch (err) {
      logger.warn('[tracking] recordConversionEvent falhou', {
        accountId: input.accountId,
        eventName: input.eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Núcleo do envio, compartilhado entre o fluxo ao vivo e a reconciliação.
   * Grava a linha de log ANTES de enviar (o id vira o event_id da Meta, então
   * qualquer retry do mesmo fato é deduplicado do lado deles).
   */
  private async dispatchEvent(
    config: ConfigRow,
    input: RecordEventInput
  ): Promise<DispatchOutcome> {
    if (!config.active) return 'disabled';
    if (!config[EVENT_TOGGLE[input.eventName]]) return 'disabled';
    if (!config.accessToken || !config.pixelId) return 'disabled';
    if (!input.ctwaClid) return 'disabled';

    const occurredAt = input.occurredAt ?? new Date();
    const ageDays = (Date.now() - occurredAt.getTime()) / 86_400_000;
    const outOfWindow = ageDays > CAPI_MAX_EVENT_AGE_DAYS;

    // Guarda de idempotência. O unique (accountId, eventName, sourceId) é a
    // rede de segurança no banco; este check evita a corrida comum.
    if (input.sourceId) {
      const existing = await prisma.trackingEvent.findFirst({
        where: {
          accountId: input.accountId,
          eventName: input.eventName,
          sourceId: input.sourceId,
        },
        select: { id: true },
      });
      if (existing) return 'duplicate';
    }

    let row: { id: string };
    try {
      row = await prisma.trackingEvent.create({
        data: {
          accountId: input.accountId,
          conversationId: input.conversationId ?? null,
          contactId: input.contactId ?? null,
          eventName: input.eventName,
          ctwaClid: input.ctwaClid,
          value: input.value ?? null,
          currency: input.currency ?? (input.value != null ? 'BRL' : null),
          sourceType: input.sourceType ?? null,
          sourceId: input.sourceId ?? null,
          status: outOfWindow ? 'skipped' : 'pending',
          error: outOfWindow
            ? `Fato de ${Math.floor(ageDays)} dias atrás — a CAPI só aceita eventos dos últimos ${CAPI_MAX_EVENT_AGE_DAYS} dias.`
            : null,
          createdAt: occurredAt,
        },
        select: { id: true },
      });
    } catch (err) {
      // P2002 = outro processo criou a mesma linha entre o check e o create.
      if ((err as { code?: string }).code === 'P2002') return 'duplicate';
      throw err;
    }

    // Fora da janela: fica registrado como 'skipped' (auditável e não some do
    // histórico), mas não vai pra Meta — ela rejeitaria.
    if (outOfWindow) return 'out_of_window';

    // Telefone do lead p/ o match secundário (user_data.ph). Best-effort:
    // uma falha aqui não pode impedir o envio do evento.
    const contact = input.contactId
      ? await prisma.contact
          .findUnique({ where: { id: input.contactId }, select: { telefone: true } })
          .catch(() => null)
      : null;

    try {
      await metaCapiService.sendEvent(
        { accessToken: config.accessToken, pixelId: config.pixelId },
        {
          eventName: input.eventName,
          ctwaClid: input.ctwaClid,
          eventTime: Math.floor(occurredAt.getTime() / 1000),
          value: input.value ?? undefined,
          currency: input.currency ?? undefined,
          // event_id estável = id da row de log; retries não contam em dobro.
          eventId: row.id,
          phone: contact?.telefone ?? null,
        }
      );
      await prisma.trackingEvent.update({
        where: { id: row.id },
        data: { status: 'sent', sentAt: new Date(), error: null },
      });
      return 'sent';
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
      return 'failed';
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

  /**
   * Conversa de anúncio mais recente de cada contato, em lote.
   *
   * Sem recorte de data de propósito: uma reunião de hoje pode vir de um lead
   * que chegou no mês passado. Limitar ao período subestimaria o resultado das
   * campanhas justamente onde o ciclo de venda é mais longo.
   */
  private async ctwaByContact(
    accountId: string,
    contactIds: string[]
  ): Promise<Map<string, CtwaHit[]>> {
    const map = new Map<string, CtwaHit[]>();
    const ids = Array.from(new Set(contactIds.filter(Boolean)));
    if (ids.length === 0) return map;

    const rows = await prisma.conversation.findMany({
      where: { accountId, contactId: { in: ids }, ctwaClid: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        contactId: true,
        ctwaClid: true,
        adSourceId: true,
        createdAt: true,
      },
    });
    // Guarda a lista inteira (já ordenada desc) em vez de só a mais recente:
    // quem escolhe é o ctwaBefore, que precisa da data do fato.
    for (const r of rows) {
      if (!r.contactId || !r.ctwaClid) continue;
      const list = map.get(r.contactId) ?? [];
      list.push({
        conversationId: r.id,
        ctwaClid: r.ctwaClid,
        adSourceId: r.adSourceId ?? '',
        createdAt: r.createdAt,
      });
      map.set(r.contactId, list);
    }
    return map;
  }

  // ============================================
  // Congruência CRM × Meta
  // ============================================

  /**
   * Fatos do CRM que deveriam ter virado evento na Meta e não viraram.
   *
   * Dedupe por sourceId (exato). Linhas legadas — anteriores à coluna
   * sourceId — não têm origem identificável; para Schedule/Purchase usamos
   * uma guarda conservadora por (conversa + dia) para nunca duplicar na Meta.
   * Lead é 1:1 com a conversa, então conversationId já basta.
   */
  async findGaps(accountId: string, from: Date, to: Date): Promise<ReconcileGap[]> {
    const gaps: ReconcileGap[] = [];
    const cutoff = Date.now() - CAPI_MAX_EVENT_AGE_DAYS * 86_400_000;
    const isRecoverable = (d: Date) => d.getTime() >= cutoff;

    // ---------- Lead: conversa de anúncio sem evento ----------
    const convs = await prisma.conversation.findMany({
      where: { accountId, ctwaClid: { not: null }, createdAt: { gte: from, lte: to } },
      select: {
        id: true,
        ctwaClid: true,
        contactId: true,
        createdAt: true,
        adHeadline: true,
      },
    });

    if (convs.length > 0) {
      const convIds = convs.map((c) => c.id);
      const leadEvents = await prisma.trackingEvent.findMany({
        where: {
          accountId,
          eventName: 'Lead',
          OR: [{ sourceId: { in: convIds } }, { conversationId: { in: convIds } }],
        },
        select: { sourceId: true, conversationId: true },
      });
      const covered = new Set<string>();
      for (const e of leadEvents) {
        if (e.sourceId) covered.add(e.sourceId);
        if (e.conversationId) covered.add(e.conversationId);
      }
      for (const c of convs) {
        if (covered.has(c.id) || !c.ctwaClid) continue;
        gaps.push({
          eventName: 'Lead',
          sourceType: 'conversation',
          sourceId: c.id,
          conversationId: c.id,
          contactId: c.contactId,
          ctwaClid: c.ctwaClid,
          occurredAt: c.createdAt,
          value: null,
          label: c.adHeadline || 'Conversa de anúncio',
          recoverable: isRecoverable(c.createdAt),
        });
      }
    }

    // ---------- Schedule: reunião de contato vindo de anúncio ----------
    const meetings = await prisma.calendarEvent.findMany({
      where: { accountId, contactId: { not: null }, createdAt: { gte: from, lte: to } },
      select: { id: true, contactId: true, createdAt: true, title: true },
    });

    if (meetings.length > 0) {
      const ctwaMap = await this.ctwaByContact(
        accountId,
        meetings.map((m) => m.contactId!).filter(Boolean)
      );
      const meetingIds = meetings.map((m) => m.id);
      const scheduleEvents = await prisma.trackingEvent.findMany({
        where: {
          accountId,
          eventName: 'Schedule',
          // Legadas (sourceId null) entram só dentro da janela — é o alcance
          // da guarda por dia; varrer o histórico inteiro seria desnecessário.
          OR: [
            { sourceId: { in: meetingIds } },
            { sourceId: null, createdAt: { gte: from, lte: to } },
          ],
        },
        select: { sourceId: true, conversationId: true, createdAt: true },
      });
      const coveredIds = new Set(
        scheduleEvents.map((e) => e.sourceId).filter((v): v is string => Boolean(v))
      );
      // Guarda legada: (conversa, dia) já tem Schedule sem origem conhecida.
      const legacyDays = new Set(
        scheduleEvents
          .filter((e) => !e.sourceId && e.conversationId)
          .map((e) => `${e.conversationId}|${dayKey(e.createdAt)}`)
      );

      for (const m of meetings) {
        // Só conta clique ANTERIOR à reunião — ver ctwaBefore.
        const ctwa = m.contactId
          ? ctwaBefore(ctwaMap.get(m.contactId), m.createdAt)
          : undefined;
        if (!ctwa) continue;
        if (coveredIds.has(m.id)) continue;
        if (legacyDays.has(`${ctwa.conversationId}|${dayKey(m.createdAt)}`)) continue;
        gaps.push({
          eventName: 'Schedule',
          sourceType: 'calendar_event',
          sourceId: m.id,
          conversationId: ctwa.conversationId,
          contactId: m.contactId,
          ctwaClid: ctwa.ctwaClid,
          occurredAt: m.createdAt,
          value: null,
          label: m.title || 'Reunião agendada',
          recoverable: isRecoverable(m.createdAt),
        });
      }
    }

    // ---------- Purchase: venda paga de contato vindo de anúncio ----------
    // status:'paid' é obrigatório — venda estornada MANTÉM paidAt preenchido.
    // Sem o filtro, um estorno viraria Purchase na Meta, e envio à CAPI não
    // tem desfazer.
    const sales = await prisma.sale.findMany({
      where: { accountId, status: 'paid', paidAt: { gte: from, lte: to } },
      select: { id: true, contactId: true, paidAt: true, valor: true },
    });

    if (sales.length > 0) {
      const ctwaMap = await this.ctwaByContact(
        accountId,
        sales.map((s) => s.contactId)
      );
      const saleIds = sales.map((s) => s.id);
      const purchaseEvents = await prisma.trackingEvent.findMany({
        where: {
          accountId,
          eventName: 'Purchase',
          OR: [
            { sourceId: { in: saleIds } },
            { sourceId: null, createdAt: { gte: from, lte: to } },
          ],
        },
        select: { sourceId: true, conversationId: true, createdAt: true },
      });
      const coveredIds = new Set(
        purchaseEvents.map((e) => e.sourceId).filter((v): v is string => Boolean(v))
      );
      const legacyDays = new Set(
        purchaseEvents
          .filter((e) => !e.sourceId && e.conversationId)
          .map((e) => `${e.conversationId}|${dayKey(e.createdAt)}`)
      );

      for (const s of sales) {
        if (!s.paidAt) continue;
        // paidAt é insumo do corte, por isso vem antes.
        const ctwa = ctwaBefore(ctwaMap.get(s.contactId), s.paidAt);
        if (!ctwa) continue;
        if (coveredIds.has(s.id)) continue;
        if (legacyDays.has(`${ctwa.conversationId}|${dayKey(s.paidAt)}`)) continue;
        gaps.push({
          eventName: 'Purchase',
          sourceType: 'sale',
          sourceId: s.id,
          conversationId: ctwa.conversationId,
          contactId: s.contactId,
          ctwaClid: ctwa.ctwaClid,
          occurredAt: s.paidAt,
          value: Number(s.valor),
          label: `Venda ${Number(s.valor).toFixed(2)}`,
          recoverable: isRecoverable(s.paidAt),
        });
      }
    }

    return gaps.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  }

  /**
   * Compara CRM × Meta e (quando dryRun=false) envia o que ficou pra trás.
   *
   * Envio retroativo é ação explícita do usuário: com dryRun=true nada sai
   * daqui, só o relatório do que sairia.
   */
  async reconcile(
    accountId: string,
    opts: { days?: number; dryRun?: boolean } = {}
  ): Promise<ReconcileReport> {
    const days = Math.min(Math.max(opts.days ?? 30, 1), 365);
    const dryRun = opts.dryRun ?? true;

    const config = await this.getConfig(accountId);
    if (!config || !config.active || !config.accessToken || !config.pixelId) {
      throw new ValidationError(
        'Ative a conexão com a Meta (token + pixel) antes de validar ou reconciliar.'
      );
    }

    const to = new Date();
    const from = new Date(to.getTime() - days * 86_400_000);
    const gaps = await this.findGaps(accountId, from, to);

    const counts = { Lead: 0, Schedule: 0, Purchase: 0 };
    for (const g of gaps) counts[g.eventName] += 1;
    const recoverable = gaps.filter((g) => g.recoverable);
    const outOfWindow = gaps.length - recoverable.length;

    const report: ReconcileReport = {
      dryRun,
      window: { from: from.toISOString(), to: to.toISOString() },
      gaps: { ...counts, total: gaps.length },
      recoverable: recoverable.length,
      outOfWindow,
      sent: 0,
      failed: 0,
      skipped: 0,
      retriedFailed: 0,
      retriedOk: 0,
      capped: false,
      samples: gaps.slice(0, 20).map((g) => ({
        eventName: g.eventName,
        label: g.label,
        occurredAt: g.occurredAt.toISOString(),
        recoverable: g.recoverable,
      })),
    };

    if (dryRun) return report;

    // Retry ANTES do backfill: assim só reprocessa falhas pré-existentes.
    // Na ordem inversa, uma falha nascida agora seria reenviada em seguida,
    // dobrando chamadas à Graph API sem ganho nenhum.
    const retry = await this.retryFailed(accountId, config);
    report.retriedFailed = retry.attempted;
    report.retriedOk = retry.ok;

    const batch = gaps.slice(0, RECONCILE_MAX_SENDS);
    report.capped = gaps.length > RECONCILE_MAX_SENDS;

    for (const gap of batch) {
      const outcome = await this.dispatchEvent(config, {
        accountId,
        eventName: gap.eventName,
        ctwaClid: gap.ctwaClid,
        conversationId: gap.conversationId,
        contactId: gap.contactId,
        value: gap.value,
        currency: gap.value != null ? 'BRL' : null,
        sourceType: gap.sourceType,
        sourceId: gap.sourceId,
        occurredAt: gap.occurredAt,
      });
      if (outcome === 'sent') report.sent += 1;
      else if (outcome === 'failed') report.failed += 1;
      else if (outcome === 'out_of_window') report.skipped += 1;
    }

    logger.info('[tracking] reconciliação concluída', {
      accountId,
      gaps: report.gaps.total,
      sent: report.sent,
      failed: report.failed,
      skipped: report.skipped,
    });

    return report;
  }

  /**
   * Reenvia eventos que falharam. Seguro por construção: o event_id é o id da
   * linha, então a Meta deduplica se o primeiro envio na verdade tinha
   * chegado.
   */
  async retryFailed(
    accountId: string,
    preloaded?: ConfigRow
  ): Promise<{ attempted: number; ok: number }> {
    const config = preloaded ?? (await this.getConfig(accountId));
    if (!config?.active || !config.accessToken || !config.pixelId) {
      return { attempted: 0, ok: 0 };
    }

    // Respeita os toggles: se o admin desligou Purchase, reprocessar uma
    // Purchase antiga reintroduziria justamente o que ele desligou.
    const enabled = (['Lead', 'Schedule', 'Purchase'] as TrackingEventName[]).filter(
      (n) => config[EVENT_TOGGLE[n]]
    );
    if (enabled.length === 0) return { attempted: 0, ok: 0 };

    const cutoff = new Date(Date.now() - CAPI_MAX_EVENT_AGE_DAYS * 86_400_000);
    // 'pending' órfão: a linha nasce antes do POST à CAPI; se o processo morrer
    // no meio (redeploy/OOM), ela fica presa e o findGaps a considera coberta —
    // o fato nunca mais viraria lacuna. Resgatamos só as paradas há >5min (não
    // brigar com envio em voo) e com no máximo 48h, que é a janela de dedupe
    // por event_id da Meta — além disso o reenvio poderia contar em dobro.
    const staleTo = new Date(Date.now() - 5 * 60_000);
    const staleFrom = new Date(Date.now() - 48 * 3_600_000);
    const failed = await prisma.trackingEvent.findMany({
      where: {
        accountId,
        eventName: { in: enabled },
        OR: [
          { status: 'failed', createdAt: { gte: cutoff } },
          { status: 'pending', sentAt: null, createdAt: { gte: staleFrom, lte: staleTo } },
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: RECONCILE_MAX_SENDS,
    });

    let ok = 0;
    for (const ev of failed) {
      const contact = ev.contactId
        ? await prisma.contact
            .findUnique({ where: { id: ev.contactId }, select: { telefone: true } })
            .catch(() => null)
        : null;
      try {
        await metaCapiService.sendEvent(
          { accessToken: config.accessToken, pixelId: config.pixelId },
          {
            eventName: ev.eventName,
            ctwaClid: ev.ctwaClid,
            eventTime: Math.floor(ev.createdAt.getTime() / 1000),
            value: ev.value != null ? Number(ev.value) : undefined,
            currency: ev.currency ?? undefined,
            eventId: ev.id,
            phone: contact?.telefone ?? null,
          }
        );
        await prisma.trackingEvent.update({
          where: { id: ev.id },
          data: { status: 'sent', sentAt: new Date(), error: null },
        });
        ok += 1;
      } catch (err) {
        await prisma.trackingEvent.update({
          where: { id: ev.id },
          data: { error: (err instanceof Error ? err.message : String(err)).slice(0, 500) },
        });
      }
    }
    return { attempted: failed.length, ok };
  }

  // ============================================
  // Funil de métricas
  // ============================================

  /**
   * Funil completo do período.
   *
   * Os totais refletem o CRM (o que de fato aconteceu). O bloco `delivery`
   * reflete a Meta (o que foi entregue). A diferença entre os dois é a
   * incongruência que a reconciliação resolve.
   */
  async getFunnel(accountId: string, from: Date, to: Date) {
    const config = await this.getConfig(accountId);
    const convWhere = { accountId, createdAt: { gte: from, lte: to } };

    const [ctwaConvRows, organicConversations, meetingRows, saleRows, deliveryGroups] =
      await Promise.all([
        // Conversas de anúncio do período com o anúncio de origem — base do
        // quebra-por-anúncio (payload pequeno: ids e rótulos).
        prisma.conversation.findMany({
          where: { ...convWhere, sourceType: 'ctwa' },
          select: {
            id: true,
            contactId: true,
            adSourceId: true,
            adHeadline: true,
            createdAt: true,
          },
        }),
        prisma.conversation.count({
          where: { ...convWhere, sourceType: { not: 'ctwa' } },
        }),
        prisma.calendarEvent.findMany({
          where: { accountId, contactId: { not: null }, createdAt: { gte: from, lte: to } },
          select: { id: true, contactId: true, createdAt: true },
        }),
        // Idem findGaps: estorno mantém paidAt, então sem status:'paid' a
        // receita do funil e o ROAS ficariam inflados.
        prisma.sale.findMany({
          where: { accountId, status: 'paid', paidAt: { gte: from, lte: to } },
          select: { id: true, contactId: true, paidAt: true, valor: true },
        }),
        prisma.trackingEvent.groupBy({
          by: ['eventName', 'status'],
          where: { accountId, createdAt: { gte: from, lte: to } },
          _count: { _all: true },
        }),
      ]);

    // ---- Atribuição: contato → conversa de anúncio → anúncio ----
    // A busca cobre TODO o histórico do contato, não só o período: reunião e
    // venda de hoje podem vir de um lead que chegou antes da janela. Recortar
    // por data aqui zeraria justamente os ciclos de venda mais longos.
    const ctwaMap = await this.ctwaByContact(accountId, [
      ...meetingRows.map((m) => m.contactId!).filter(Boolean),
      ...saleRows.map((s) => s.contactId),
    ]);

    // Mesmo corte temporal do findGaps: o anúncio só leva o crédito se o
    // clique veio ANTES da reunião/venda.
    const ctwaMeetings = meetingRows.filter(
      (m) => m.contactId && ctwaBefore(ctwaMap.get(m.contactId), m.createdAt)
    );
    const ctwaSales = saleRows.filter(
      (s) => s.contactId && s.paidAt && ctwaBefore(ctwaMap.get(s.contactId), s.paidAt)
    );
    const revenue = ctwaSales.reduce((acc, s) => acc + Number(s.valor), 0);
    const adOfContact = (contactId: string | null, at: Date): string =>
      (contactId && ctwaBefore(ctwaMap.get(contactId), at)?.adSourceId) || '';

    // ---- Gasto na Meta (por anúncio e por dia, numa chamada só) ----
    const fmt = (d: Date) => d.toISOString().slice(0, 10);
    const canReadSpend = Boolean(config?.active && config.accessToken && config.adAccountId);
    const insights = canReadSpend
      ? await metaCapiService.getAdInsights(
          config!.accessToken!,
          config!.adAccountId!,
          fmt(from),
          fmt(to),
          { daily: true }
        )
      : { rows: [], error: null as string | null };

    const spendRows = insights.rows;
    const totalSpend = spendRows.reduce((acc, r) => acc + r.spend, 0);

    // ---- Nomes de anúncio/campanha, mesmo sem gasto no período ----
    const adIdsFromConvs = Array.from(
      new Set(ctwaConvRows.map((c) => c.adSourceId).filter((v): v is string => Boolean(v)))
    );
    const knownFromSpend = new Set(spendRows.map((r) => r.adId));
    const missingNames = adIdsFromConvs.filter((id) => !knownFromSpend.has(id));
    const adMeta =
      canReadSpend && missingNames.length > 0
        ? await metaCapiService.getAdMeta(config!.accessToken!, missingNames)
        : new Map();

    // ---- Agregação por anúncio ----
    const byAd = new Map<string, AdAgg>();
    const ensureAd = (adId: string): AdAgg => {
      let agg = byAd.get(adId);
      if (!agg) {
        agg = {
          adId,
          adName: '',
          campaignId: '',
          campaignName: '',
          spend: 0,
          impressions: 0,
          linkClicks: 0,
          conversations: 0,
          meetings: 0,
          purchases: 0,
          revenue: 0,
          costPerConversation: null,
          roas: null,
        };
        byAd.set(adId, agg);
      }
      return agg;
    };

    for (const row of spendRows) {
      const agg = ensureAd(row.adId);
      agg.adName = row.adName || agg.adName;
      agg.campaignId = row.campaignId || agg.campaignId;
      agg.campaignName = row.campaignName || agg.campaignName;
      agg.spend += row.spend;
      agg.impressions += row.impressions;
      agg.linkClicks += row.linkClicks;
    }
    for (const c of ctwaConvRows) {
      const agg = ensureAd(c.adSourceId ?? '');
      agg.conversations += 1;
      if (!agg.adName) {
        const meta = adMeta.get(c.adSourceId ?? '');
        agg.adName = meta?.adName || c.adHeadline || '';
        if (meta?.campaignName) {
          agg.campaignId = meta.campaignId;
          agg.campaignName = meta.campaignName;
        }
      }
    }
    for (const m of ctwaMeetings) {
      ensureAd(adOfContact(m.contactId, m.createdAt)).meetings += 1;
    }
    for (const s of ctwaSales) {
      const agg = ensureAd(adOfContact(s.contactId, s.paidAt!));
      agg.purchases += 1;
      agg.revenue += Number(s.valor);
    }
    for (const agg of byAd.values()) {
      agg.costPerConversation =
        agg.conversations > 0 && agg.spend > 0 ? agg.spend / agg.conversations : null;
      agg.roas = agg.spend > 0 ? agg.revenue / agg.spend : null;
    }

    // ---- Agregação por campanha ----
    const byCampaign = new Map<string, CampaignAgg>();
    for (const ad of byAd.values()) {
      const key = ad.campaignId || ad.campaignName || 'sem-campanha';
      let agg = byCampaign.get(key);
      if (!agg) {
        agg = {
          campaignId: ad.campaignId,
          campaignName: ad.campaignName || 'Campanha não identificada',
          ads: 0,
          spend: 0,
          conversations: 0,
          meetings: 0,
          purchases: 0,
          revenue: 0,
          costPerConversation: null,
          roas: null,
        };
        byCampaign.set(key, agg);
      }
      agg.ads += 1;
      agg.spend += ad.spend;
      agg.conversations += ad.conversations;
      agg.meetings += ad.meetings;
      agg.purchases += ad.purchases;
      agg.revenue += ad.revenue;
    }
    for (const agg of byCampaign.values()) {
      agg.costPerConversation =
        agg.conversations > 0 && agg.spend > 0 ? agg.spend / agg.conversations : null;
      agg.roas = agg.spend > 0 ? agg.revenue / agg.spend : null;
    }

    // ---- Série diária ----
    const daily = new Map<string, FunnelDailyPoint>();
    const ensureDay = (date: string): FunnelDailyPoint => {
      let p = daily.get(date);
      if (!p) {
        p = { date, spend: 0, conversations: 0, meetings: 0, purchases: 0, revenue: 0 };
        daily.set(date, p);
      }
      return p;
    };
    for (const r of spendRows) if (r.date) ensureDay(r.date).spend += r.spend;
    for (const c of ctwaConvRows) ensureDay(dayKey(c.createdAt)).conversations += 1;
    for (const m of ctwaMeetings) ensureDay(dayKey(m.createdAt)).meetings += 1;
    for (const s of ctwaSales) {
      const p = ensureDay(dayKey(s.paidAt!));
      p.purchases += 1;
      p.revenue += Number(s.valor);
    }

    // ---- Entrega na Meta (o outro lado da congruência) ----
    const deliveryBy = new Map<string, DeliveryStat>();
    for (const name of ['Lead', 'Schedule', 'Purchase'] as TrackingEventName[]) {
      deliveryBy.set(name, { eventName: name, sent: 0, pending: 0, failed: 0, skipped: 0 });
    }
    for (const g of deliveryGroups) {
      const stat = deliveryBy.get(g.eventName as TrackingEventName);
      if (!stat) continue;
      const n = g._count._all;
      if (g.status === 'sent') stat.sent += n;
      else if (g.status === 'pending') stat.pending += n;
      else if (g.status === 'failed') stat.failed += n;
      else if (g.status === 'skipped') stat.skipped += n;
    }

    const ctwaConversations = ctwaConvRows.length;
    const meetings = ctwaMeetings.length;
    const purchases = ctwaSales.length;

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      connected: Boolean(config?.active),
      spendAvailable: spendRows.length > 0,
      /** Motivo real quando o investimento não pôde ser lido. */
      spendError: insights.error,
      hasAdAccount: Boolean(config?.adAccountId),
      totals: {
        spend: totalSpend,
        impressions: spendRows.reduce((a, r) => a + r.impressions, 0),
        linkClicks: spendRows.reduce((a, r) => a + r.linkClicks, 0),
        ctwaConversations,
        organicConversations,
        meetings,
        purchases,
        revenue,
        costPerConversation:
          ctwaConversations > 0 && totalSpend > 0 ? totalSpend / ctwaConversations : null,
        costPerMeeting: meetings > 0 && totalSpend > 0 ? totalSpend / meetings : null,
        costPerPurchase: purchases > 0 && totalSpend > 0 ? totalSpend / purchases : null,
        roas: totalSpend > 0 ? revenue / totalSpend : null,
        convRate: ctwaConversations > 0 ? meetings / ctwaConversations : null,
        closeRate: meetings > 0 ? purchases / meetings : null,
      },
      delivery: Array.from(deliveryBy.values()),
      daily: Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date)),
      byCampaign: Array.from(byCampaign.values()).sort((a, b) => b.spend - a.spend),
      byAd: Array.from(byAd.values()).sort(
        (a, b) => b.spend - a.spend || b.conversations - a.conversations
      ),
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
