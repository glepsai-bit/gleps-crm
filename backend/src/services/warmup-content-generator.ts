/**
 * T-023 Fase 2 — Warmup Content Generator
 *
 * Camada acima dos providers que decide em runtime: usar IA (se pool.useAi e
 * provider habilitado) ou cair em template. SEMPRE retorna conteudo (nunca
 * bloqueia o tick — falha de IA vira `source='fallback'`).
 *
 * Contratos:
 *  - pool.useAi=false (default) -> sempre template, sem custo, sem rede.
 *  - pool.useAi=true + provider invalido/disabled -> template (source='template').
 *  - pool.useAi=true + provider OK + IA retorna -> usa IA (source='openai'|'anthropic').
 *  - pool.useAi=true + provider OK + IA retorna null -> template marcado como fallback.
 *
 * Auditoria: o caller (whatsapp-warmup.service) persiste `contentSource` em
 * WarmupMessage usando GeneratedContent.source.
 */

import type {
  WarmupPool,
  WarmupNumber,
  WarmupConversation,
  WarmupTemplate,
} from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { getProvider } from './ai/registry';
import type {
  ConversationHistoryItem,
  GeneratedContent,
  WarmupTone,
} from './ai/types';

export type WarmupMessageType = 'text' | 'audio' | 'sticker' | 'image' | 'reaction';

interface TypeWeights {
  text: number;
  reaction: number;
  audio: number;
  sticker: number;
  image: number;
}

function getTypeWeightsForDay(day: number): TypeWeights {
  if (day <= 3) return { text: 100, reaction: 0, audio: 0, sticker: 0, image: 0 };
  if (day <= 7) return { text: 75, reaction: 25, audio: 0, sticker: 0, image: 0 };
  if (day <= 14) return { text: 50, reaction: 25, audio: 15, sticker: 10, image: 0 };
  return { text: 40, reaction: 20, audio: 20, sticker: 10, image: 10 };
}

function getCategoryForDay(day: number): 'greeting' | 'response' | 'smalltalk' {
  if (day <= 3) return Math.random() < 0.7 ? 'greeting' : 'response';
  if (day <= 7) {
    const r = Math.random();
    if (r < 0.4) return 'greeting';
    if (r < 0.8) return 'response';
    return 'smalltalk';
  }
  return 'smalltalk';
}

function pickTypeByWeights(weights: TypeWeights): WarmupMessageType {
  const total =
    weights.text + weights.reaction + weights.audio + weights.sticker + weights.image;
  let r = Math.random() * total;
  if ((r -= weights.text) < 0) return 'text';
  if ((r -= weights.reaction) < 0) return 'reaction';
  if ((r -= weights.audio) < 0) return 'audio';
  if ((r -= weights.sticker) < 0) return 'sticker';
  return 'image';
}

const ALLOWED_TONES: ReadonlyArray<WarmupTone> = ['casual', 'formal', 'gym', 'clinic'];
function normalizeTone(tone?: string | null): WarmupTone {
  if (tone && (ALLOWED_TONES as readonly string[]).includes(tone)) {
    return tone as WarmupTone;
  }
  return 'casual';
}

export class WarmupContentGenerator {
  /**
   * Ponto de entrada. Caller (warmup tick) passa o pool, conversa e dia.
   */
  async pick(
    pool: Pick<WarmupPool, 'useAi' | 'aiProvider' | 'aiModel' | 'aiTone'>,
    conversation: Pick<WarmupConversation, 'id'> | null,
    number: Pick<WarmupNumber, 'id' | 'accountId' | 'currentDay'>,
  ): Promise<GeneratedContent> {
    const currentDay = number.currentDay;

    if (pool.useAi && pool.aiProvider) {
      const provider = getProvider(pool.aiProvider);
      if (provider && provider.isEnabled()) {
        const history = conversation
          ? await this.fetchHistory(conversation.id, number.id)
          : [];
        const generated = await provider.generate(
          {
            currentDay,
            conversationHistory: history,
            tone: normalizeTone(pool.aiTone),
          },
          pool.aiModel ?? undefined,
        );

        if (generated) {
          if (generated.cost) {
            logger.debug('[warmup-content] gerado por IA', {
              provider: generated.source,
              model: generated.model,
              usd: generated.cost.usdEstimate.toFixed(6),
              inputTokens: generated.cost.inputTokens,
              outputTokens: generated.cost.outputTokens,
            });
          }
          return generated;
        }

        // IA disponivel mas falhou -> template marcado como fallback
        const fb = await this.pickFromTemplate(currentDay, number.accountId);
        return { ...fb, source: 'fallback' };
      }
    }

    // Default: template puro
    return this.pickFromTemplate(currentDay, number.accountId);
  }

  /**
   * Recupera ate as ultimas 4 mensagens da conversa (mais recentes ao final)
   * e mapeia para o formato { sender: 'me'|'peer', content }, na perspectiva
   * do numero que vai enviar (`selfId`).
   */
  private async fetchHistory(
    conversationId: string,
    selfId: string,
  ): Promise<ConversationHistoryItem[]> {
    const recent = await prisma.warmupMessage.findMany({
      where: { conversationId, content: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 4,
      select: { senderId: true, content: true },
    });
    return recent
      .reverse()
      .map(m => ({
        sender: m.senderId === selfId ? 'me' : 'peer',
        content: m.content ?? '',
      }))
      .filter(m => m.content.length > 0) as ConversationHistoryItem[];
  }

  /**
   * Reimplementacao do pickContent do whatsapp-warmup.service.ts em formato
   * GeneratedContent. Mantem mesma logica de fases/categorias/peso por template.
   */
  private async pickFromTemplate(
    currentDay: number,
    accountId: string,
  ): Promise<GeneratedContent> {
    const weights = getTypeWeightsForDay(currentDay);
    const type = pickTypeByWeights(weights);

    const category =
      type === 'text'
        ? getCategoryForDay(currentDay)
        : type === 'reaction'
          ? 'reaction'
          : 'media';

    const templates: WarmupTemplate[] = await prisma.warmupTemplate.findMany({
      where: {
        type,
        category,
        isActive: true,
        OR: [{ accountId: null }, { accountId }],
      },
    });

    if (templates.length === 0) {
      // Sem template — retorna placeholder vazio com source template; caller
      // pode tratar como skip se quiser.
      return {
        source: 'template',
        type,
        content: '',
      };
    }

    const total = templates.reduce((s, t) => s + (t.weight ?? 1), 0);
    let r = Math.random() * total;
    let chosen = templates[0];
    for (const t of templates) {
      r -= t.weight ?? 1;
      if (r <= 0) {
        chosen = t;
        break;
      }
    }

    return {
      source: 'template',
      type,
      content: chosen.content,
      templateId: chosen.id,
    };
  }
}

export const warmupContentGenerator = new WarmupContentGenerator();
