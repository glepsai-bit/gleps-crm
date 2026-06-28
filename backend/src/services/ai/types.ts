/**
 * T-023 Fase 2 — tipos compartilhados pelos providers de IA do warmup.
 *
 * Provider pattern: cada implementacao (OpenAI, Anthropic, ...) implementa
 * AiProvider. O registry (registry.ts) seleciona qual provider usar em runtime
 * com base na config da WarmupPool. Quando nenhum provider esta habilitado
 * (env vars ausentes) ou o provider escolhido retorna null, o
 * warmup-content-generator faz fallback automatico pra template.
 */

export type AiProviderName = 'openai' | 'anthropic';
export type WarmupTone = 'casual' | 'formal' | 'gym' | 'clinic';

export interface ConversationHistoryItem {
  sender: 'me' | 'peer';
  content: string;
}

export interface ContentContext {
  currentDay: number;
  conversationHistory: ConversationHistoryItem[];
  tone: WarmupTone;
  language?: string;
}

export interface GeneratedContentCost {
  inputTokens: number;
  outputTokens: number;
  usdEstimate: number;
}

/**
 * Tipos de mensagem que warmup pode disparar. IA so produz 'text' ou
 * 'reaction'; templates podem produzir qualquer um dos 5.
 */
export type WarmupGeneratedType = 'text' | 'reaction' | 'audio' | 'sticker' | 'image';

export interface GeneratedContent {
  source: AiProviderName | 'template' | 'fallback';
  type: WarmupGeneratedType;
  /** Texto puro (text), caption (image), placeholder (audio/sticker) ou emoji (reaction) */
  content: string;
  model?: string;
  cost?: GeneratedContentCost;
  templateId?: string;
  /** V2: caminho relativo a UPLOADS_ROOT (preferido por padrao) */
  mediaPath?: string;
  /** V2: URL absoluta (override pra CDN/S3) */
  mediaUrl?: string;
  /** V2: mime type da midia (debug/logger) */
  mediaMimeType?: string;
}

export interface AiProvider {
  readonly name: AiProviderName;
  readonly defaultModel: string;
  isEnabled(): boolean;
  generate(ctx: ContentContext, model?: string): Promise<GeneratedContent | null>;
}
