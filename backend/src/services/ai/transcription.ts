/**
 * T-027 Fase 1 — transcrição de áudio (Whisper).
 *
 * O lead manda áudio no WhatsApp o tempo todo. Hoje quem transcreve é o nó
 * `Transcreve_Audio1` do n8n; sem isso aqui dentro, a IA nativa ignoraria todo
 * áudio recebido — que é metade das mensagens em muitas contas.
 *
 * Só OpenAI: a Anthropic não transcreve áudio. Mesma regra dos embeddings.
 */

import { toFile } from 'openai';
import { getOpenAI, resolveKey } from './client-factory';
import { AppError } from '../../utils/errors';
import { logger } from '../../utils/logger';

const MODEL = 'whisper-1';
const TIMEOUT_MS = 120_000;
/** Teto da API: 25 MB. */
const MAX_BYTES = 25 * 1024 * 1024;

/** $0.006 por minuto de áudio. */
const USD_PER_MINUTE = 0.006;

export interface TranscriptionResult {
  text: string;
  /** Duração em segundos quando a API reporta; 0 quando não. */
  durationSec: number;
  usdEstimate: number;
}

/**
 * `mimeType` só existe pra derivar a extensão do arquivo: a API do Whisper
 * decide o decoder pelo NOME do arquivo, não pelo conteúdo. Sem extensão
 * plausível, áudio de WhatsApp (ogg/opus) é rejeitado como formato inválido.
 */
export async function transcribe(
  accountId: string,
  buffer: Buffer,
  mimeType: string,
  language = 'pt'
): Promise<TranscriptionResult> {
  if (buffer.length === 0) {
    throw new AppError('Áudio vazio — nada para transcrever.', 400);
  }
  if (buffer.length > MAX_BYTES) {
    throw new AppError(
      `Áudio de ${(buffer.length / 1024 / 1024).toFixed(1)} MB excede o limite de 25 MB da transcrição.`,
      413
    );
  }

  try {
    await resolveKey(accountId, 'openai');
  } catch {
    throw new AppError(
      'A transcrição de áudio precisa de uma chave OpenAI (a Anthropic não transcreve áudio). ' +
        'Cadastre em Administração → Integrações.',
      503
    );
  }

  const client = await getOpenAI(accountId, TIMEOUT_MS);
  const file = await toFile(buffer, `audio.${extensionFor(mimeType)}`, { type: mimeType });

  const res = await client.audio.transcriptions.create({
    file,
    model: MODEL,
    language,
    response_format: 'verbose_json',
  });

  // verbose_json traz `duration`; o tipo do SDK é o da resposta simples, daí o cast.
  const durationSec = Number((res as unknown as { duration?: number }).duration ?? 0);
  const text = (res.text ?? '').trim();

  if (!text) {
    logger.warn('[ai/transcription] áudio transcrito vazio', { accountId, mimeType });
  }

  return {
    text,
    durationSec,
    usdEstimate: (durationSec / 60) * USD_PER_MINUTE,
  };
}

const EXTENSIONS: Record<string, string> = {
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

function extensionFor(mimeType: string): string {
  // A Evolution manda 'audio/ogg; codecs=opus' — o parâmetro faz o lookup falhar.
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return EXTENSIONS[base] ?? 'ogg';
}
