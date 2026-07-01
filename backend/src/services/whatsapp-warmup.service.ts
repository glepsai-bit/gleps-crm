/**
 * T-023 — WhatsApp Warmup Service
 *
 * Responsavel por orquestrar o aquecimento de chips Evolution dentro de pools.
 * - Plano diario de envios baseado em strategy (conservative|moderate|aggressive)
 * - Cron tick 60s: roda janela horaria 08-20h tz da conta, pareia conversa, gera
 *   conteudo via templates ponderados por fase do protocolo, envia via Evolution
 *   e atualiza qualityScore + auto-pause/auto-promocao.
 * - Anti-ban: jitter 50%, alternancia A/B, auto-pause se qualityScore < 60,
 *   auto-promocao day>=21 + quality>=80 + zero falhas 3d -> status='warm'.
 *
 * evolutionService.sendText eh chamado direto; em testes deve ser mockado.
 */

import type {
  WarmupNumber,
  WarmupConversation,
} from '@prisma/client';
import { prisma } from '../config/database';
import { evolutionService } from './evolution.service';
import { NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { warmupContentGenerator } from './warmup-content-generator';
import type { GeneratedContent } from './ai/types';
import { resolveMediaPayload } from './warmup-media-loader';

// ============================================
// Types
// ============================================

export type WarmupStrategy = 'conservative' | 'moderate' | 'aggressive';
export type WarmupStatus = 'cold' | 'warming' | 'warm' | 'paused' | 'banned' | 'error';
export type WarmupMessageType = 'text' | 'audio' | 'sticker' | 'image' | 'reaction';

export interface StartNumberInput {
  numberId: string;
  accountId: string;
}

export interface PauseNumberInput {
  numberId: string;
  accountId: string;
  reason?: string;
}

export interface ResumeNumberInput {
  numberId: string;
  accountId: string;
}

interface PickContentResult {
  type: WarmupMessageType;
  content: string;
  templateId?: string;
  source: GeneratedContent['source'];
  mediaPath?: string;
  mediaUrl?: string;
  mediaMimeType?: string;
}

// ============================================
// Constants
// ============================================

const WINDOW_START_HOUR = 8;
const WINDOW_END_HOUR = 20;
const JITTER_SKIP_PROB = 0.5;
const QUALITY_AUTO_PAUSE_THRESHOLD = 60;
const QUALITY_FAILURE_PENALTY = 5;
const QUALITY_BAN_PENALTY = 15;
const PROMOTION_MIN_DAY = 21;
const PROMOTION_MIN_QUALITY = 80;
const PROMOTION_ZERO_FAIL_DAYS = 3;
const DEFAULT_TZ = 'America/Sao_Paulo';

// Curvas pre-definidas por strategy (30 dias)
// MVP: moderate eh o default. Conservative cresce mais devagar; aggressive cresce
// mais rapido (maior risco de ban).
function buildCurve(start: number, end: number, days = 30): number[] {
  const plan: number[] = [];
  // Fase rapida nos primeiros 7 dias (curva linear leve), depois linear ate end.
  for (let i = 0; i < days; i++) {
    if (i === 0) plan.push(start);
    else if (i < 7) {
      // crescimento linear nos primeiros 7 dias entre start e ~end/4
      const week1End = Math.round(end / 4);
      const frac = i / 6;
      plan.push(Math.round(start + (week1End - start) * frac));
    } else {
      const week1End = Math.round(end / 4);
      const frac = (i - 6) / (days - 7);
      plan.push(Math.round(week1End + (end - week1End) * frac));
    }
  }
  return plan;
}

const STRATEGY_CURVES: Record<WarmupStrategy, number[]> = {
  conservative: buildCurve(5, 150, 30),
  moderate: buildCurve(10, 200, 30),
  aggressive: buildCurve(15, 300, 30),
};

// Overrides explicitos pros primeiros dias da moderate (compromisso documentado)
STRATEGY_CURVES.moderate[0] = 10;
STRATEGY_CURVES.moderate[1] = 12;
STRATEGY_CURVES.moderate[2] = 15;
STRATEGY_CURVES.moderate[3] = 20;
STRATEGY_CURVES.moderate[4] = 25;
STRATEGY_CURVES.moderate[5] = 30;
STRATEGY_CURVES.moderate[6] = 40;

STRATEGY_CURVES.conservative[0] = 5;
STRATEGY_CURVES.conservative[1] = 7;
STRATEGY_CURVES.conservative[2] = 10;
STRATEGY_CURVES.conservative[3] = 15;
STRATEGY_CURVES.conservative[4] = 20;
STRATEGY_CURVES.conservative[5] = 25;
STRATEGY_CURVES.conservative[6] = 30;

STRATEGY_CURVES.aggressive[0] = 15;
STRATEGY_CURVES.aggressive[1] = 20;
STRATEGY_CURVES.aggressive[2] = 30;
STRATEGY_CURVES.aggressive[3] = 50;
STRATEGY_CURVES.aggressive[4] = 70;
STRATEGY_CURVES.aggressive[5] = 90;
STRATEGY_CURVES.aggressive[6] = 120;

// ============================================
// Helpers de tz
// ============================================

function getLocalHourInTz(date: Date, tz: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(date);
  const hourPart = parts.find(p => p.type === 'hour');
  const h = hourPart ? parseInt(hourPart.value, 10) : 0;
  // Intl pode retornar '24' em meia-noite em algumas runtimes — normalizar
  return h === 24 ? 0 : h;
}

function getLocalDateInTz(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(date); // YYYY-MM-DD
}

function isInsideWindow(date: Date, tz: string): boolean {
  const h = getLocalHourInTz(date, tz);
  return h >= WINDOW_START_HOUR && h < WINDOW_END_HOUR;
}

// Fracao da janela que ja decorreu (0..1).
function windowElapsedFraction(date: Date, tz: string): number {
  const h = getLocalHourInTz(date, tz);
  const minutesFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    minute: '2-digit',
  });
  const minStr = minutesFmt.formatToParts(date).find(p => p.type === 'minute')?.value ?? '0';
  const totalMin = (h - WINDOW_START_HOUR) * 60 + parseInt(minStr, 10);
  const windowMin = (WINDOW_END_HOUR - WINDOW_START_HOUR) * 60;
  return Math.min(Math.max(totalMin / windowMin, 0), 1);
}

// ============================================
// Ponderacao de conteudo por fase do protocolo
// ============================================

interface TypeWeights {
  text: number;
  reaction: number;
  audio: number;
  sticker: number;
  image: number;
}

function getTypeWeightsForDay(day: number): TypeWeights {
  // V2 (T-023): media liberada a partir de D4 (chip aquecido o suficiente).
  // Fase 1 (D1-D3): 90% text + 10% reaction (sem midia)
  if (day <= 3) return { text: 90, reaction: 10, audio: 0, sticker: 0, image: 0 };
  // Fase 2 (D4-D7): libera audio + image + sticker
  if (day <= 7) return { text: 65, reaction: 10, audio: 15, sticker: 5, image: 5 };
  // Fase 3 (D8-D14): mais midia
  if (day <= 14) return { text: 50, reaction: 10, audio: 20, sticker: 10, image: 10 };
  // Fase 4 (D15+): mistura plena
  return { text: 45, reaction: 10, audio: 20, sticker: 12, image: 13 };
}

// ============================================
// Service
// ============================================

class WhatsappWarmupService {
  // Curvas expostas para inspecao/testes
  readonly curves = STRATEGY_CURVES;

  // ============================================
  // Lifecycle do number
  // ============================================

  async startNumber(input: StartNumberInput): Promise<WarmupNumber> {
    const number = await prisma.warmupNumber.findFirst({
      where: { id: input.numberId, accountId: input.accountId },
      include: { pool: true },
    });
    if (!number) throw new NotFoundError('Warmup number');

    if (number.status === 'warming') {
      throw new ValidationError('Numero ja esta em aquecimento');
    }

    const strategy = (number.pool.strategy as WarmupStrategy) ?? 'moderate';
    const curve = STRATEGY_CURVES[strategy] ?? STRATEGY_CURVES.moderate;

    return prisma.warmupNumber.update({
      where: { id: input.numberId },
      data: {
        status: 'warming',
        currentDay: 1,
        startedAt: new Date(),
        dailyEnvioPlan: curve as unknown as any,
        dailyEnviadasHoje: 0,
        dailyRecebidasHoje: 0,
        qualityScore: 100,
        pausedReason: null,
      },
    });
  }

  async pauseNumber(input: PauseNumberInput): Promise<WarmupNumber> {
    const number = await prisma.warmupNumber.findFirst({
      where: { id: input.numberId, accountId: input.accountId },
    });
    if (!number) throw new NotFoundError('Warmup number');
    if (number.status === 'paused') return number;

    return prisma.warmupNumber.update({
      where: { id: input.numberId },
      data: {
        status: 'paused',
        pausedReason: input.reason ?? 'pausado manualmente',
      },
    });
  }

  async resumeNumber(input: ResumeNumberInput): Promise<WarmupNumber> {
    const number = await prisma.warmupNumber.findFirst({
      where: { id: input.numberId, accountId: input.accountId },
    });
    if (!number) throw new NotFoundError('Warmup number');
    if (number.status !== 'paused') {
      throw new ValidationError(
        `Numero nao esta pausado (status atual: ${number.status})`
      );
    }

    return prisma.warmupNumber.update({
      where: { id: input.numberId },
      data: {
        status: 'warming',
        pausedReason: null,
      },
    });
  }

  // ============================================
  // Cron tick
  // ============================================

  /**
   * Chamado pelo cron a cada 60s. Itera sobre numbers status='warming' e tenta
   * disparar uma mensagem se condicoes baterem (janela, plano, jitter, peer disponivel).
   *
   * Retorna contadores pra observabilidade.
   */
  async tick(now: Date = new Date()): Promise<{ checked: number; sent: number; skipped: number; failed: number }> {
    const numbers = await prisma.warmupNumber.findMany({
      where: { status: 'warming' },
      include: { account: { select: { timezone: true } }, pool: true },
    });

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    // BUG-WARMUP-001: log agregador — se tick termina com sent=0 mas checked>0,
    // usuario precisa saber POR QUE. Coletamos razoes por number pra emitir
    // resumo unico ao final (ex.: '[warmup-tick] checked=3 sent=0 razoes: window=1, no-partner=2').
    const skipReasons: Record<string, number> = {};
    const bump = (key: string) => {
      skipReasons[key] = (skipReasons[key] ?? 0) + 1;
    };

    for (const num of numbers) {
      try {
        const tz = num.account?.timezone || DEFAULT_TZ;

        // 1) Rollover de dia
        await this.rolloverIfNeeded(num, now, tz);

        // Re-le state pos-rollover (currentDay/contadores podem ter mudado)
        const fresh = await prisma.warmupNumber.findUnique({ where: { id: num.id } });
        if (!fresh || fresh.status !== 'warming') {
          skipped++;
          bump('not-warming');
          continue;
        }

        // BUG-WARMUP-002: se pool.isActive=false, respeita — nao envia (mesmo
        // que status='warming'). Anteriormente ignorava esse flag, o que
        // permitia envios de pool desativada.
        if (num.pool && num.pool.isActive === false) {
          skipped++;
          bump('pool-inactive');
          continue;
        }

        // 2) Janela horaria
        if (!isInsideWindow(now, tz)) {
          skipped++;
          bump('window');
          continue;
        }

        // 3) Cota planejada vs ja enviado
        const planArr = (fresh.dailyEnvioPlan as unknown as number[] | null) ?? [];
        const dayIdx = Math.max(fresh.currentDay - 1, 0);
        const plannedToday = planArr[dayIdx] ?? 0;

        // BUG-WARMUP-003 (raiz do "nada envia"): antes usavamos
        // Math.floor(plannedToday * elapsed) como cota parcial. Isso trava o
        // 1o envio no inicio da janela: em D1 (plannedToday=10) as 08:15,
        // elapsed=~0.02 → target=0 → dailyEnviadasHoje(0) >= 0 → SKIP.
        // A cota so libera 1 envio quando plannedToday * elapsed >= 1
        // (~72min em D1, ~1h em D2). Usuario clica "iniciar" e nao ve
        // NENHUMA mensagem por 1h+. Correcao: usa Math.ceil e garante
        // pelo menos 1 envio permitido assim que entra na janela e ha plano.
        const elapsed = windowElapsedFraction(now, tz);
        let targetUpToNow = Math.ceil(plannedToday * elapsed);
        if (plannedToday > 0 && elapsed > 0 && targetUpToNow < 1) {
          targetUpToNow = 1;
        }
        if (fresh.dailyEnviadasHoje >= plannedToday) {
          skipped++;
          bump('cota-cheia');
          continue;
        }
        if (fresh.dailyEnviadasHoje >= targetUpToNow) {
          skipped++;
          bump('cota-parcial');
          continue;
        }

        // 4) Jitter 50%
        if (Math.random() < JITTER_SKIP_PROB) {
          skipped++;
          bump('jitter');
          continue;
        }

        // 5) Parear conversa
        const peer = await this.pickPeer(fresh);
        if (!peer) {
          skipped++;
          bump('no-partner');
          continue;
        }
        const conv = await this.getOrCreateConversation(fresh, peer);

        // 6) Alternancia: se o ultimo sender foi este numero, ceder turno
        if (conv.lastSenderId === fresh.id) {
          skipped++;
          bump('turn');
          continue;
        }

        // 7) Gerar conteudo (template ou IA, decidido pela pool via generator)
        const generated = await warmupContentGenerator.pick(
          num.pool,
          conv,
          fresh,
        );
        if (!generated.content) {
          // Sem template/conteudo disponivel — skip do tick
          skipped++;
          bump('no-template');
          logger.warn('[warmup-tick] sem template disponivel', {
            numberId: fresh.id,
            poolId: fresh.poolId,
            currentDay: fresh.currentDay,
            requestedType: generated.type,
            hint: 'rode seed-warmup ou cadastre WarmupTemplate isActive=true type=text',
          });
          continue;
        }
        const content: PickContentResult = {
          type: generated.type as WarmupMessageType,
          content: generated.content,
          templateId: generated.templateId,
          source: generated.source,
          mediaPath: generated.mediaPath,
          mediaUrl: generated.mediaUrl,
          mediaMimeType: generated.mediaMimeType,
        };

        // 8) Enviar via Evolution (multi-tipo: text/audio/sticker/image/reaction)
        const result = await this.sendViaEvolution(fresh, peer, content, conv.id);

        // 9) Persistir mensagem + contadores + quality
        await this.recordSend({
          number: fresh,
          peer,
          conv,
          content,
          result,
          now,
        });

        if (result.success) sent++;
        else failed++;

        // 10) Auto-pause / auto-promocao
        await this.applyHealthChecks(fresh.id, now);
      } catch (err: any) {
        failed++;
        bump('exception');
        logger.error('[warmup] tick error', {
          numberId: num.id,
          error: err?.message ?? String(err),
        });
      }
    }

    // BUG-WARMUP-001: se houver numbers ativos e nenhuma msg saiu, emite
    // resumo claro com razao(oes) predominante(s) — usuario nao precisa
    // ler codigo pra debugar por que "nada enviou".
    if (numbers.length > 0 && sent === 0) {
      const reasons = Object.entries(skipReasons)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      logger.info(
        `[warmup-tick] checked=${numbers.length} sent=0 razoes: ${reasons || 'nenhuma'}`
      );
    }

    return { checked: numbers.length, sent, skipped, failed };
  }

  // ============================================
  // Rollover
  // ============================================

  private async rolloverIfNeeded(num: WarmupNumber, now: Date, tz: string): Promise<void> {
    const today = getLocalDateInTz(now, tz);
    const lastActivity = num.lastActivityAt ?? num.startedAt ?? num.createdAt;
    const lastDate = getLocalDateInTz(lastActivity, tz);

    if (lastDate === today) return;
    // Roolover: persistir snapshot do dia anterior + reset contadores + day++
    const planArr = (num.dailyEnvioPlan as unknown as number[] | null) ?? [];
    const prevDayIdx = Math.max(num.currentDay - 1, 0);
    const plannedPrev = planArr[prevDayIdx] ?? 0;

    // upsert atomico evita duplicacao se 2 ticks rodarem em paralelo
    const prevDate = new Date(`${lastDate}T12:00:00Z`);

    // BUG-006: failedSends antes era hardcoded 0, transformando o safeguard
    // 'zero falhas 3 dias' em no-op (auto-promocao acontecia ate em chips com
    // falhas reais). Calculamos agora a partir de WarmupMessage do dia local
    // anterior (UTC simplificado — janela [lastDate, lastDate+1d]).
    let failedPrev = 0;
    try {
      const dayStart = new Date(`${lastDate}T00:00:00Z`);
      const dayEnd = new Date(`${lastDate}T23:59:59.999Z`);
      failedPrev = await prisma.warmupMessage.count({
        where: {
          senderId: num.id,
          status: 'failed',
          createdAt: { gte: dayStart, lte: dayEnd },
        },
      });
    } catch (err: any) {
      logger.warn('[warmup] rollover failedSends count failed', {
        numberId: num.id,
        error: err?.message ?? String(err),
      });
    }

    try {
      await prisma.warmupDailyStats.upsert({
        where: { numberId_date: { numberId: num.id, date: prevDate } },
        create: {
          numberId: num.id,
          date: prevDate,
          protocolDay: num.currentDay,
          plannedSends: plannedPrev,
          actualSends: num.dailyEnviadasHoje,
          actualReceives: num.dailyRecebidasHoje,
          failedSends: failedPrev,
          qualityEnd: num.qualityScore,
          statusEnd: num.status,
        },
        update: {
          actualSends: num.dailyEnviadasHoje,
          actualReceives: num.dailyRecebidasHoje,
          failedSends: failedPrev,
          qualityEnd: num.qualityScore,
          statusEnd: num.status,
        },
      });
    } catch (err: any) {
      logger.warn('[warmup] rollover stats upsert failed', {
        numberId: num.id,
        error: err?.message ?? String(err),
      });
    }

    await prisma.warmupNumber.update({
      where: { id: num.id },
      data: {
        currentDay: { increment: 1 },
        dailyEnviadasHoje: 0,
        dailyRecebidasHoje: 0,
        lastActivityAt: now,
      },
    });
  }

  // ============================================
  // Pareamento de peer
  // ============================================

  private async pickPeer(num: WarmupNumber): Promise<WarmupNumber | null> {
    // Pareamento eh SEMPRE intra-tenant (mesmo accountId). Sem cross-account,
    // sem pool publica — regra LGPD + isolamento multi-tenant estrito.
    const peers = await prisma.warmupNumber.findMany({
      where: {
        accountId: num.accountId,
        poolId: num.poolId,
        status: 'warming',
        id: { not: num.id },
      },
    });
    if (peers.length === 0) return null;
    // Prioriza peer com inboundDeficit (recebidasHoje < enviadasHoje)
    const sorted = peers.slice().sort((a, b) => {
      const da = (a.dailyEnviadasHoje ?? 0) - (a.dailyRecebidasHoje ?? 0);
      const db = (b.dailyEnviadasHoje ?? 0) - (b.dailyRecebidasHoje ?? 0);
      return db - da;
    });
    // 70% chance de pegar o topo (deficit), 30% aleatorio (variedade)
    if (Math.random() < 0.7) return sorted[0];
    return peers[Math.floor(Math.random() * peers.length)];
  }

  private async getOrCreateConversation(
    a: WarmupNumber,
    b: WarmupNumber
  ): Promise<WarmupConversation> {
    // Ordena IDs pra garantir unicidade idempotente (unique [numberAId, numberBId])
    const [first, second] = [a, b].sort((x, y) => (x.id < y.id ? -1 : 1));
    const existing = await prisma.warmupConversation.findUnique({
      where: { numberAId_numberBId: { numberAId: first.id, numberBId: second.id } },
    });
    if (existing) return existing;
    return prisma.warmupConversation.create({
      data: {
        poolId: a.poolId,
        numberAId: first.id,
        numberBId: second.id,
        isActive: true,
      },
    });
  }

  // ============================================
  // Envio via Evolution
  // ============================================

  private async sendViaEvolution(
    sender: WarmupNumber,
    peer: WarmupNumber,
    content: PickContentResult,
    conversationId?: string,
  ): Promise<{ success: boolean; evolutionMsgId?: string; error?: string }> {
    try {
      let result: { messageId: string; raw: any };

      switch (content.type) {
        case 'text': {
          result = await evolutionService.sendText(sender.accountId, {
            number: peer.phoneE164,
            text: content.content,
            instance: sender.evolutionInstance,
          });
          break;
        }

        case 'audio': {
          const audioPayload = await resolveMediaPayload({
            mediaUrl: content.mediaUrl,
            mediaPath: content.mediaPath,
          });
          result = await evolutionService.sendAudio(sender.accountId, {
            number: peer.phoneE164,
            // sendAudio aceita URL OU data: URL — payload base64 raw vira data:audio
            audioUrl: this.toEvolutionMediaPayload(audioPayload, content.mediaMimeType ?? 'audio/ogg'),
            instance: sender.evolutionInstance,
          });
          break;
        }

        case 'sticker': {
          const stickerPayload = await resolveMediaPayload({
            mediaUrl: content.mediaUrl,
            mediaPath: content.mediaPath,
          });
          result = await evolutionService.sendSticker(sender.accountId, {
            number: peer.phoneE164,
            sticker: stickerPayload,
            instance: sender.evolutionInstance,
          });
          break;
        }

        case 'image': {
          const imagePayload = await resolveMediaPayload({
            mediaUrl: content.mediaUrl,
            mediaPath: content.mediaPath,
          });
          result = await evolutionService.sendMedia(sender.accountId, {
            number: peer.phoneE164,
            mediaType: 'image',
            mediaUrl: this.toEvolutionMediaPayload(imagePayload, content.mediaMimeType ?? 'image/jpeg'),
            caption: content.content,
            instance: sender.evolutionInstance,
          });
          break;
        }

        case 'reaction': {
          // Reaction requer evolutionMsgId da ultima msg do peer.
          // Sem peer msg id -> fallback text.
          const lastPeerMsg = conversationId
            ? await prisma.warmupMessage.findFirst({
                where: {
                  conversationId,
                  senderId: peer.id,
                  evolutionMsgId: { not: null },
                },
                orderBy: { createdAt: 'desc' },
              })
            : null;

          if (lastPeerMsg?.evolutionMsgId) {
            result = await evolutionService.sendReaction(sender.accountId, {
              number: peer.phoneE164,
              reaction: content.content,
              reactionToMsgId: lastPeerMsg.evolutionMsgId,
              instance: sender.evolutionInstance,
            });
          } else {
            // Fallback: vira text — marcamos type='text' pra audit correto
            result = await evolutionService.sendText(sender.accountId, {
              number: peer.phoneE164,
              text: content.content,
              instance: sender.evolutionInstance,
            });
            content.type = 'text';
          }
          break;
        }

        default: {
          // Fallback paranoico: trata tipo desconhecido como texto
          result = await evolutionService.sendText(sender.accountId, {
            number: peer.phoneE164,
            text: content.content,
            instance: sender.evolutionInstance,
          });
        }
      }

      return { success: true, evolutionMsgId: result?.messageId };
    } catch (err: any) {
      return { success: false, error: err?.message ?? String(err) };
    }
  }

  /**
   * Converte payload de midia (base64 raw OU URL) no formato esperado pelos
   * sendMedia/sendAudio existentes da Evolution (URL http(s) OU data:...).
   * Se ja eh URL/data: passa direto.
   */
  private toEvolutionMediaPayload(payload: string, mimeType: string): string {
    if (/^https?:\/\//i.test(payload) || /^data:/i.test(payload)) {
      return payload;
    }
    // base64 raw -> data URL
    return `data:${mimeType};base64,${payload}`;
  }

  // ============================================
  // Persistencia + qualityScore
  // ============================================

  private async recordSend(args: {
    number: WarmupNumber;
    peer: WarmupNumber;
    conv: WarmupConversation;
    content: PickContentResult;
    result: { success: boolean; evolutionMsgId?: string; error?: string };
    now: Date;
  }): Promise<void> {
    const { number, peer, conv, content, result, now } = args;

    await prisma.warmupMessage.create({
      data: {
        conversationId: conv.id,
        senderId: number.id,
        receiverId: peer.id,
        messageType: content.type,
        content: content.content,
        contentSource: content.source,
        evolutionMsgId: result.evolutionMsgId ?? null,
        status: result.success ? 'sent' : 'failed',
        errorMessage: result.error ?? null,
        sentAt: result.success ? now : null,
      },
    });

    if (result.success) {
      await prisma.warmupConversation.update({
        where: { id: conv.id },
        data: {
          lastSenderId: number.id,
          lastTurnAt: now,
          turnsCount: { increment: 1 },
        },
      });
      await prisma.warmupNumber.update({
        where: { id: number.id },
        data: {
          dailyEnviadasHoje: { increment: 1 },
          lastActivityAt: now,
        },
      });
      await prisma.warmupNumber.update({
        where: { id: peer.id },
        data: {
          dailyRecebidasHoje: { increment: 1 },
          lastActivityAt: now,
        },
      });
    } else {
      // Penaliza qualityScore (diferenca entre falha generica e ban Evolution)
      const isBan = /ban|forbidden|429|blocked/i.test(result.error ?? '');
      const penalty = isBan ? QUALITY_BAN_PENALTY : QUALITY_FAILURE_PENALTY;
      await prisma.warmupNumber.update({
        where: { id: number.id },
        data: {
          qualityScore: { decrement: penalty },
          lastActivityAt: now,
        },
      });
    }
  }

  // ============================================
  // Health checks (auto-pause + auto-promocao)
  // ============================================

  private async applyHealthChecks(numberId: string, now: Date): Promise<void> {
    const num = await prisma.warmupNumber.findUnique({ where: { id: numberId } });
    if (!num || num.status !== 'warming') return;

    // Auto-pause se qualityScore baixo
    if (num.qualityScore < QUALITY_AUTO_PAUSE_THRESHOLD) {
      await prisma.warmupNumber.update({
        where: { id: numberId },
        data: {
          status: 'paused',
          pausedReason: `Auto-pause: qualityScore=${num.qualityScore} < ${QUALITY_AUTO_PAUSE_THRESHOLD}`,
        },
      });
      logger.warn('[warmup] auto-paused number', { numberId, qualityScore: num.qualityScore });
      return;
    }

    // Auto-promocao: day >= 21 + quality >= 80 + zero falhas 3 dias seguidos
    if (num.currentDay >= PROMOTION_MIN_DAY && num.qualityScore >= PROMOTION_MIN_QUALITY) {
      const threeDaysAgo = new Date(now.getTime() - PROMOTION_ZERO_FAIL_DAYS * 24 * 60 * 60 * 1000);
      const recentStats = await prisma.warmupDailyStats.findMany({
        where: { numberId, date: { gte: threeDaysAgo } },
        orderBy: { date: 'desc' },
        take: PROMOTION_ZERO_FAIL_DAYS,
      });
      const enoughDays = recentStats.length >= PROMOTION_ZERO_FAIL_DAYS;
      const zeroFails = recentStats.every(s => s.failedSends === 0);
      if (enoughDays && zeroFails) {
        await prisma.warmupNumber.update({
          where: { id: numberId },
          data: { status: 'warm' },
        });
        logger.info('[warmup] auto-promoted number to warm', { numberId });
      }
    }
  }
}

export const whatsappWarmupService = new WhatsappWarmupService();
export { STRATEGY_CURVES, isInsideWindow, getTypeWeightsForDay };
