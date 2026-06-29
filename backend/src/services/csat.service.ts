/**
 * CSAT SERVICE — SLA v2 (T-022)
 *
 * Customer satisfaction automatico. Roda como cron periódico:
 *   1) sendPendingCsatMessages — envia a pergunta de CSAT pros ciclos
 *      que foram resolvidos com csatRequested=true e ainda nao tiveram
 *      a pergunta enviada (csatSentAt IS NULL). Espera 15min apos resolve
 *      pra nao parecer bot, limita a 24h apos resolve (depois disso, abandona).
 *
 *   2) parseCustomerResponse — recebe uma mensagem inbound e tenta parsear
 *      como resposta de CSAT (1-5, "ruim", "otimo", "5/5", etc). Se parseou
 *      e existe ciclo com csatSentAt setado e customerCsat nulo, grava.
 *
 * Mensagem padrao: "Como voce avalia o atendimento de 1 a 5? (1=ruim, 5=otimo)"
 *
 * IMPORTANTE: testes mockam messageService.create pra nao bater no DB
 * Evolution. WhatsApp REAL só pra 5534993383017 (regra global do projeto).
 */

import { prisma } from '../config/database';
import { ConflictError, NotFoundError } from '../utils/errors';
import { logger } from '../utils/logger';
import { messageService } from './message.service';

// ============================================
// Constants
// ============================================

const CSAT_MESSAGE_TEXT =
  'Como voce avalia o atendimento de 1 a 5? (1=ruim, 5=otimo)';

// Espera minima entre resolve e envio da CSAT (default: 15 min)
const CSAT_DELAY_AFTER_RESOLVE_MS = 15 * 60 * 1000;

// Janela maxima de envio (default: 24h)
const CSAT_MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

// ============================================
// Types
// ============================================

export interface SendPendingCsatResult {
  sent: number;
  failed: number;
  skipped: number;
}

export interface ParseCsatResult {
  matched: boolean;
  rating: number | null;
  cycleId: string | null;
}

export interface SendCsatNowOptions {
  /**
   * Texto custom da pergunta. Se omitido, usa CSAT_MESSAGE_TEXT padrao.
   */
  customMessage?: string;
  /**
   * Forca reenvio mesmo se csatSentAt ja estiver setado. Util quando
   * agente quer pedir avaliacao de novo (cliente nao respondeu na 1a vez).
   * Sem force, ciclos ja perguntados retornam 409 ConflictError.
   */
  force?: boolean;
}

export interface SendCsatNowResult {
  sent: true;
  sentAt: Date;
  cycleId: string;
  messageText: string;
}

// ============================================
// Helpers
// ============================================

/**
 * Parser de resposta de CSAT. Aceita:
 *   - "1" "2" "3" "4" "5"
 *   - "5/5" "3/5"
 *   - "nota 4" "avalio em 5"
 *   - "ruim" = 1, "pessimo" = 1
 *   - "ok" = 3, "regular" = 3
 *   - "bom" = 4
 *   - "otimo" = 5, "excelente" = 5
 *
 * Retorna null se nao conseguir parsear (mensagem normal — nao bloqueia
 * o fluxo principal, so nao grava CSAT).
 */
export function parseRatingFromText(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text.trim().toLowerCase();
  if (!normalized) return null;

  // Match direto "1".."5" como mensagem inteira
  if (/^[1-5]$/.test(normalized)) {
    return Number(normalized);
  }

  // Match "5/5", "3 / 5"
  const slashMatch = normalized.match(/^([1-5])\s*\/\s*5$/);
  if (slashMatch) {
    return Number(slashMatch[1]);
  }

  // Match "nota X" ou "X estrelas"
  const notaMatch = normalized.match(/\b([1-5])\s*(estrelas?|pontos?)?\b/);

  // Heuristica por palavra-chave (apenas se nao tiver numero ambiguo)
  if (/\bp[eé]ssimo\b/.test(normalized) || /\bruim\b/.test(normalized)) {
    return 1;
  }
  if (/\b[óo]timo\b/.test(normalized) || /\bexcelente\b/.test(normalized)) {
    return 5;
  }
  if (/\bbom\b/.test(normalized)) {
    return 4;
  }
  if (/\bregular\b/.test(normalized) || /\bok\b/.test(normalized)) {
    return 3;
  }

  if (notaMatch) {
    return Number(notaMatch[1]);
  }

  return null;
}

// ============================================
// Service
// ============================================

class CsatService {
  /**
   * Envia CSAT IMEDIATO pra uma conversation especifica (sem esperar o cron
   * de 15min). Usado quando o agente ou a IA querem capturar a avaliacao do
   * cliente naquele momento — via botao "Pedir avaliacao" na UI ou via
   * endpoint de integracao (n8n / IA externa).
   *
   * Comportamento:
   *  - Busca o ConversationCycle aberto OU o mais recente da conversation.
   *  - Se ja foi enviado (csatSentAt != null) e options.force !== true:
   *    lanca ConflictError. Idempotencia explicita — agente reenvia so se
   *    quiser de verdade.
   *  - Cria Message do tipo system com o texto da pergunta (default ou
   *    options.customMessage).
   *  - Atualiza o cycle: csatRequested=true, csatSentAt=now.
   *
   * Diferente do cron sendPendingCsatMessages, este metodo:
   *  - Nao aplica janela de 15min/24h (envio sob demanda).
   *  - Lanca erro em vez de "skip" silencioso — caller precisa saber.
   *  - Aceita force pra reenvio explicito.
   */
  async sendCsatNow(
    conversationId: string,
    accountId: string,
    options: SendCsatNowOptions = {}
  ): Promise<SendCsatNowResult> {
    // Garante que a conversation existe e pertence a conta — senao 404.
    const conversation = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: { id: true },
    });
    if (!conversation) {
      throw new NotFoundError('Conversa');
    }

    // Preferencia: ciclo aberto. Fallback: ciclo mais recente (resolvido).
    // openedAt desc cobre os 2 casos com 1 query — se houver aberto, vem 1o.
    const cycle = await prisma.conversationCycle.findFirst({
      where: { conversationId, accountId },
      orderBy: [{ resolvedAt: 'desc' }, { openedAt: 'desc' }],
    });

    if (!cycle) {
      throw new NotFoundError('ConversationCycle');
    }

    if (cycle.csatSentAt && !options.force) {
      throw new ConflictError(
        'CSAT ja foi enviado para este ciclo. Use force=true para reenviar.',
        { cycleId: cycle.id, csatSentAt: cycle.csatSentAt.toISOString() }
      );
    }

    const messageText =
      options.customMessage && options.customMessage.trim().length > 0
        ? options.customMessage
        : CSAT_MESSAGE_TEXT;

    const now = new Date();

    await messageService.create(accountId, {
      conversationId,
      senderType: 'system',
      senderId: null,
      content: messageText,
      contentType: 'text',
      metadata: {
        csat_request: true,
        cycleId: cycle.id,
        source: 'csat_service.sendCsatNow',
        force: options.force === true ? true : undefined,
      },
    });

    await prisma.conversationCycle.update({
      where: { id: cycle.id },
      data: {
        csatRequested: true,
        csatSentAt: now,
      },
    });

    logger.info('[csat] sendCsatNow', {
      accountId,
      conversationId,
      cycleId: cycle.id,
      force: options.force === true,
    });

    return {
      sent: true,
      sentAt: now,
      cycleId: cycle.id,
      messageText,
    };
  }

  /**
   * Envia mensagem de CSAT pros ciclos elegiveis. Idempotente via guard
   * csatSentAt — nao envia 2x. Best-effort: erros individuais nao abortam
   * o batch.
   *
   * Criterios de elegibilidade:
   *   - csatRequested = true
   *   - csatSentAt IS NULL (nao enviado ainda)
   *   - resolvedAt > now - 24h  (janela maxima)
   *   - resolvedAt < now - 15min (espera minima)
   */
  async sendPendingCsatMessages(now: Date = new Date()): Promise<SendPendingCsatResult> {
    const result: SendPendingCsatResult = { sent: 0, failed: 0, skipped: 0 };

    const windowStart = new Date(now.getTime() - CSAT_MAX_WINDOW_MS);
    const windowEnd = new Date(now.getTime() - CSAT_DELAY_AFTER_RESOLVE_MS);

    const pendingCycles = await prisma.conversationCycle.findMany({
      where: {
        csatRequested: true,
        csatSentAt: null,
        resolvedAt: {
          gt: windowStart,
          lt: windowEnd,
        },
      },
      include: {
        conversation: {
          include: {
            contact: { select: { telefone: true } },
            inbox: { select: { channelType: true } },
          },
        },
      },
    });

    for (const cycle of pendingCycles) {
      try {
        // CSAT so faz sentido pra WhatsApp (ou outros canais conversacionais).
        // Sem inbox/contact nao da pra mandar mensagem — skip.
        if (!cycle.conversation?.contact?.telefone) {
          result.skipped += 1;
          continue;
        }

        await messageService.create(cycle.accountId, {
          conversationId: cycle.conversationId,
          senderType: 'system',
          senderId: null,
          content: CSAT_MESSAGE_TEXT,
          contentType: 'text',
          metadata: {
            csat_request: true,
            cycleId: cycle.id,
            source: 'csat_service',
          },
        });

        await prisma.conversationCycle.update({
          where: { id: cycle.id },
          data: { csatSentAt: now },
        });

        result.sent += 1;
      } catch (err) {
        result.failed += 1;
        logger.warn('[csat] falha ao enviar mensagem', {
          cycleId: cycle.id,
          conversationId: cycle.conversationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.sent > 0 || result.failed > 0) {
      logger.info('[csat] sendPendingCsatMessages', { ...result });
    }

    return result;
  }

  /**
   * Tenta parsear uma mensagem inbound como resposta de CSAT.
   * - Busca ciclo da conversa com csatSentAt != null AND customerCsat IS NULL
   * - Tenta parsear o texto via parseRatingFromText
   * - Se ambos baterem, grava customerCsat + customerCsatAt e cria nota interna.
   *
   * Retorna { matched: false } silenciosamente quando nao houver match —
   * o caller (webhook) deve continuar o processamento normal da mensagem.
   */
  async parseCustomerResponse(
    conversationId: string,
    accountId: string,
    text: string | null | undefined,
    now: Date = new Date()
  ): Promise<ParseCsatResult> {
    // Busca ciclo elegivel — ja foi pedido CSAT mas nao respondido.
    const cycle = await prisma.conversationCycle.findFirst({
      where: {
        conversationId,
        accountId,
        csatSentAt: { not: null },
        customerCsat: null,
      },
      orderBy: { csatSentAt: 'desc' },
    });

    if (!cycle) {
      return { matched: false, rating: null, cycleId: null };
    }

    const rating = parseRatingFromText(text);
    if (rating === null) {
      return { matched: false, rating: null, cycleId: cycle.id };
    }

    try {
      await prisma.conversationCycle.update({
        where: { id: cycle.id },
        data: {
          customerCsat: rating,
          customerCsatAt: now,
        },
      });

      // Nota interna automatica (best-effort, nao bloqueia gravacao do CSAT)
      try {
        await messageService.create(accountId, {
          conversationId,
          senderType: 'system',
          senderId: null,
          content: `Cliente respondeu CSAT: ${rating}`,
          contentType: 'system_note',
          isPrivate: true,
          metadata: {
            csat_response: true,
            cycleId: cycle.id,
            rating,
            source: 'csat_service',
          },
        });
      } catch (noteErr) {
        logger.debug('[csat] falha ao criar nota interna do CSAT', {
          cycleId: cycle.id,
          error: noteErr instanceof Error ? noteErr.message : String(noteErr),
        });
      }

      logger.info('[csat] customer response recorded', {
        cycleId: cycle.id,
        conversationId,
        rating,
      });

      return { matched: true, rating, cycleId: cycle.id };
    } catch (err) {
      logger.warn('[csat] falha ao gravar customerCsat', {
        cycleId: cycle.id,
        rating,
        error: err instanceof Error ? err.message : String(err),
      });
      return { matched: false, rating, cycleId: cycle.id };
    }
  }
}

export const csatService = new CsatService();
