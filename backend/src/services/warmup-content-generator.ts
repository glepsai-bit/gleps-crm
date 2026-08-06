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
  // Fase 1 (D1-D3): 90% text + 10% reaction (sem midia ainda — chip fresco)
  if (day <= 3) return { text: 90, reaction: 10, audio: 0, sticker: 0, image: 0 };
  // Fase 2 (D4-D7): libera audio + image + sticker
  if (day <= 7) return { text: 65, reaction: 10, audio: 15, sticker: 5, image: 5 };
  // Fase 3 (D8-D14): mais midia
  if (day <= 14) return { text: 50, reaction: 10, audio: 20, sticker: 10, image: 10 };
  // Fase 4 (D15+): mistura plena
  return { text: 45, reaction: 10, audio: 20, sticker: 12, image: 13 };
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

/**
 * FIX-WARMUP-NO-TEMPLATE: fallback de texto hardcoded. Sem isto, uma account
 * que nunca cadastrou WarmupTemplate (nem rodou o seed) trava o aquecimento em
 * 0 enviadas — o gerador devolvia content vazio e o tick pulava com
 * 'no-template' indefinidamente. Como o aquecimento é tráfego sintético entre
 * os próprios chips, mensagens casuais curtas bastam pra gerar volume natural.
 */
const DEFAULT_TEXT_FALLBACKS: readonly string[] = [
  'oi, tudo bem?',
  'bom dia!',
  'e aí, como você tá?',
  'tudo tranquilo por aí?',
  'opa, beleza?',
  'como foi o dia?',
  'tudo certo?',
  'oi! alguma novidade?',
  'boa tarde',
  'fala! tudo bem contigo?',
  'e aí, tudo em cima?',
  'oi, sumido! como vai?',
  'tudo joia?',
  'como tá a semana?',
  'oi, tudo bem por aí?',
  'salve! tudo certo?',
  'e aí, firmeza?',
  'bom te falar 🙂',
  'tudo bem? bom te ver por aqui',
  'oi 😄 como vc tá?',
];
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

        // IA disponivel mas falhou -> SEMPRE forca text fallback (nao re-sortear
        // type, pra evitar caso onde pickFromTemplate sorteia reaction/media sem
        // template disponivel e devolve content vazio). pickTextFallback sempre
        // retorna text valido OU greeting default hardcoded.
        const fb = await this.pickTextFallback(currentDay, number.accountId);
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
   *
   * V2 (T-023): se sorteia type='audio'|'sticker'|'image' mas a account nao
   * tem WarmupTemplate desse tipo ativo (ainda nao fez upload de midia),
   * faz FAIL-SOFT pra text (logger.debug). Garante que o ciclo de aquecimento
   * nao trava por ausencia de midia.
   */
  private async pickFromTemplate(
    currentDay: number,
    accountId: string,
    _depth = 0,
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
      // FIX-WARMUP-NO-TEMPLATE: sem template do tipo sorteado, caímos no text
      // fallback — que agora SEMPRE tem conteúdo (templates do banco OU
      // greetings hardcoded). Antes, text/reaction sem template devolvia vazio
      // e o tick pulava com 'no-template' pra sempre (aquecimento travado em 0
      // quando a account não tem WarmupTemplate). Vale pra todos os tipos;
      // _depth guard evita recursão.
      if (_depth < 1) {
        if (type === 'audio' || type === 'sticker' || type === 'image') {
          logger.debug('[warmup-content] sem mídia do tipo, fallback pra texto', {
            type,
            currentDay,
            accountId,
          });
        }
        return this.pickTextFallback(currentDay, accountId);
      }
      return { source: 'template', type, content: '' };
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

    const out: GeneratedContent = {
      source: 'template',
      type,
      content: chosen.content,
      templateId: chosen.id,
    };

    // V2: anexa metadados de midia pra service usar com resolveMediaPayload
    if (type === 'audio' || type === 'sticker' || type === 'image') {
      if (chosen.mediaPath) out.mediaPath = chosen.mediaPath;
      if (chosen.mediaUrl) out.mediaUrl = chosen.mediaUrl;
      if (chosen.mediaMimeType) out.mediaMimeType = chosen.mediaMimeType;

      // Se template tipo midia mas sem mediaPath E sem mediaUrl, fallback text.
      if (!chosen.mediaPath && !chosen.mediaUrl && _depth < 1) {
        logger.debug('[warmup-content] media template sem mediaPath/mediaUrl, fallback text', {
          templateId: chosen.id,
          type,
        });
        return this.pickTextFallback(currentDay, accountId);
      }
    }

    return out;
  }

  /**
   * Busca direta de um text template (greeting/response) — usado como
   * fallback quando sorteamos midia mas nao temos template disponivel.
   */
  private async pickTextFallback(
    currentDay: number,
    accountId: string,
  ): Promise<GeneratedContent> {
    const category = getCategoryForDay(currentDay);
    const templates: WarmupTemplate[] = await prisma.warmupTemplate.findMany({
      where: {
        type: 'text',
        category,
        isActive: true,
        OR: [{ accountId: null }, { accountId }],
      },
    });

    if (templates.length === 0) {
      // FIX-WARMUP-NO-TEMPLATE: sem WarmupTemplate de texto (account nunca
      // rodou o seed, ou não há template da categoria do dia), o retorno vazio
      // travava o aquecimento em 0 enviadas. Greeting hardcoded garante que o
      // ciclo sempre tem o que enviar.
      const content =
        DEFAULT_TEXT_FALLBACKS[
          Math.floor(Math.random() * DEFAULT_TEXT_FALLBACKS.length)
        ];
      return { source: 'fallback', type: 'text', content };
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
      type: 'text',
      content: chosen.content,
      templateId: chosen.id,
    };
  }
}

export const warmupContentGenerator = new WarmupContentGenerator();
