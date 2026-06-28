/**
 * T-023 Fase 2 — prompt builder compartilhado entre providers.
 *
 * Centraliza o prompt para que OpenAI e Anthropic gerem mensagens com o mesmo
 * estilo (warmup informal pt-BR). Cada provider injeta o prompt no formato
 * nativo (chat.completions / messages.create).
 */

import type { ContentContext } from './types';

const TONE_PERSONAS: Record<string, string> = {
  casual: 'amigo casual conversando no WhatsApp',
  formal: 'colega de trabalho profissional mas amigavel',
  gym: 'amigo de academia, fala de treino as vezes',
  clinic: 'paciente em conversa natural sobre rotina/saude',
};

export function buildWarmupPrompt(ctx: ContentContext): string {
  const lastMsgs = ctx.conversationHistory
    .slice(-4)
    .map(m => `${m.sender === 'me' ? 'Eu' : 'Amigo'}: ${m.content}`)
    .join('\n');

  const tonePersona = TONE_PERSONAS[ctx.tone] ?? TONE_PERSONAS.casual;

  return `Voce eh um ${tonePersona} respondendo no WhatsApp em portugues brasileiro.

${lastMsgs ? 'Conversa ate agora:\n' + lastMsgs + '\n' : ''}
Responda com 2-10 palavras em portugues brasileiro INFORMAL.
Ortografia casual aceita ("voce" -> "vc", omissao de acentos OK).
Sem emoji a menos que MUITO natural.
NAO use aspas. Apenas a resposta direta, sem prefixos.`;
}

/**
 * Limpa a resposta crua do provider:
 *  - remove aspas envolventes
 *  - remove bullet/dash inicial
 *  - remove prefixos "Eu:" / "Amigo:" que o modelo as vezes vaza
 *  - rejeita resposta vazia ou maior que 200 chars (sinal de prompt corrompido)
 */
export function parseAiResponse(text: string | null | undefined): string | null {
  if (!text) return null;
  const cleaned = text
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^\s*[-•]\s*/, '')
    .replace(/^(Eu:|Amigo:)\s*/i, '')
    .trim();
  if (!cleaned) return null;
  if (cleaned.length > 200) return null;
  return cleaned;
}
