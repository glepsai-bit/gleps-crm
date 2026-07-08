/**
 * audio-transcode.util — converte audio gravado no navegador para OGG/Opus
 * antes de enviar via Evolution `sendWhatsAppAudio`.
 *
 * Contexto: Chrome/Edge nao suportam `audio/ogg;codecs=opus` no MediaRecorder
 * e caem em `audio/webm;codecs=opus`. O Baileys/Evolution PTT (`encoding:true`)
 * so renderiza como bubble de voz nativo do WhatsApp quando recebe OGG/Opus —
 * WebM/Opus chega como "documento" no aparelho destinatario.
 *
 * O util decide se precisa transcodar (source mime), chama `ffmpeg` via child
 * process e devolve o buffer OGG. Timeout defensivo evita travar um dispatch
 * caso o binario nao esteja instalado ou o audio esteja corrompido.
 */

import { spawn } from 'child_process';
import { logger } from './logger';

const TRANSCODE_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Decodifica o payload base64 de uma RFC 2397 data URL. O payload esta sempre
 * depois do PRIMEIRO `,` — nao importa se o media type tem parametros
 * (`data:audio/webm;codecs=opus;base64,...` do Chrome/Edge/Firefox) ou nao
 * (`data:audio/ogg;base64,...` de clientes custom).
 *
 * Ha uma versao antiga que usava a regex `/^data:[^;]+;base64,/` — a regex
 * so faz match em media types SEM parametros e retornava a data URL inteira
 * como base64. Buffer.from decodifica lixo e o util transcode falha silencio-
 * samente. Este helper garante o parse correto e e coberto por teste.
 *
 * @throws Error se o dataUrl nao contiver virgula.
 */
export function decodeDataUrlBase64(dataUrl: string): Buffer {
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx < 0) {
    throw new Error('data URL invalida: sem virgula separando header de payload');
  }
  return Buffer.from(dataUrl.slice(commaIdx + 1), 'base64');
}

/**
 * True quando o mimetype de entrada ja e OGG (nesse caso nao precisamos
 * transcodar — Firefox / clientes custom que ja mandam OGG passam direto).
 * Case-insensitive; ignora parametros (`codecs=opus`).
 */
export function isOggOpus(mimeType: string | undefined | null): boolean {
  if (!mimeType) return false;
  const base = mimeType.split(';')[0].trim().toLowerCase();
  return base === 'audio/ogg' || base === 'audio/opus';
}

export interface TranscodeResult {
  buffer: Buffer;
  mimeType: 'audio/ogg';
  /**
   * True quando o ffmpeg rodou de fato. False = passou direto (input ja era
   * OGG) ou o binario nao esta disponivel e caimos no fallback (buffer
   * devolvido inalterado). Util para telemetria/log.
   */
  transcoded: boolean;
}

/**
 * Converte um buffer de audio arbitrario (WebM/Opus, MP4/AAC, WAV, etc.) para
 * OGG/Opus mono 48kHz — formato que o Baileys aceita como PTT nativo.
 *
 * Estrategia:
 *   1. Se `sourceMime` ja e OGG (Firefox), retorna o buffer inalterado.
 *   2. Roda `ffmpeg -i pipe:0 -c:a libopus -ar 48000 -ac 1 -f ogg pipe:1`
 *      com input via stdin e output via stdout.
 *   3. Se `ffmpeg` falhar (binario ausente / codec ausente / audio corrompido)
 *      loga warn e devolve o buffer original com `transcoded:false` — o
 *      dispatch tenta assim mesmo (comportamento pre-fix, sem regressao).
 *
 * NAO levanta em falha de transcode: manter o envio robusto e mais importante
 * do que garantir PTT em todos os casos. O caller decide o que fazer com
 * `result.transcoded`.
 */
export async function transcodeToOggOpus(
  sourceBuffer: Buffer,
  sourceMime: string | undefined | null
): Promise<TranscodeResult> {
  if (isOggOpus(sourceMime)) {
    return { buffer: sourceBuffer, mimeType: 'audio/ogg', transcoded: false };
  }

  const startedAt = Date.now();
  try {
    const output = await runFfmpeg(sourceBuffer);
    // Success signal — o operador precisa saber que o fix esta ativo em prod
    // (sem isso um rebuild que perca ffmpeg volta a mandar WebM silenciosamente).
    logger.info('[audio-transcode] ok', {
      sourceMime,
      sourceBytes: sourceBuffer.length,
      outputBytes: output.length,
      durationMs: Date.now() - startedAt,
    });
    return { buffer: output, mimeType: 'audio/ogg', transcoded: true };
  } catch (err) {
    logger.warn('[audio-transcode] falha ao transcodar para OGG/Opus', {
      sourceMime,
      sourceBytes: sourceBuffer.length,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return { buffer: sourceBuffer, mimeType: 'audio/ogg', transcoded: false };
  }
}

function runFfmpeg(input: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn',
      '-c:a', 'libopus',
      '-b:a', '32k',
      '-ar', '48000',
      '-ac', '1',
      '-f', 'ogg',
      'pipe:1',
    ]);

    const chunks: Buffer[] = [];
    let totalOut = 0;
    let stderrBuf = '';
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        reject(new Error(`ffmpeg timeout apos ${TRANSCODE_TIMEOUT_MS}ms`));
      });
    }, TRANSCODE_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      totalOut += chunk.length;
      if (totalOut > MAX_OUTPUT_BYTES) {
        settle(() => {
          clearTimeout(timer);
          try { child.kill('SIGKILL'); } catch { /* noop */ }
          reject(new Error('ffmpeg output excede MAX_OUTPUT_BYTES'));
        });
        return;
      }
      chunks.push(chunk);
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      settle(() => {
        clearTimeout(timer);
        reject(err);
      });
    });

    child.on('close', (code) => {
      settle(() => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(Buffer.concat(chunks));
        } else {
          const trimmed = stderrBuf.trim().slice(-300);
          reject(new Error(`ffmpeg exit ${code}: ${trimmed || '(sem stderr)'}`));
        }
      });
    });

    child.stdin.on('error', (err) => {
      settle(() => {
        clearTimeout(timer);
        reject(err);
      });
    });

    child.stdin.end(input);
  });
}
