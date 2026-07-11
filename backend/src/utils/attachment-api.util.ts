/**
 * AUDIT-PERF-INLINE: anexos enviados inline (≤5MB) persistem o base64 inteiro
 * em Attachment.fileUrl. Devolver isso cru em list/get/socket fazia cada
 * abertura/troca de conversa baixar MEGABYTES de JSON — a causa direta do
 * delay percebido no chat. Nas respostas de API o fileUrl inline passa a
 * apontar pro proxy autenticado /api/attachments/<id> (que materializa em
 * disco on-demand e faz stream); o front (AudioPlayer/AttachmentRenderer)
 * já suporta esse formato com Bearer + blob.
 *
 * IMPORTANTE: usar SOMENTE na borda da API/socket — fluxos internos (retry,
 * dispatch, materialize) precisam do fileUrl original do banco.
 */

// Qualquer coisa acima disso em fileUrl é inline/base64 — data URLs pequenos
// (thumbs) continuam passando direto.
const INLINE_URL_THRESHOLD = 2048;

interface ApiAttachmentShape {
  id: string;
  fileUrl: string;
  thumbnailUrl?: string | null;
}

function isHeavyInline(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.startsWith('data:') && url.length > INLINE_URL_THRESHOLD;
}

export function sanitizeAttachmentForApi<T extends ApiAttachmentShape>(att: T): T {
  const heavyMain = isHeavyInline(att.fileUrl);
  const heavyThumb = isHeavyInline(att.thumbnailUrl);
  if (!heavyMain && !heavyThumb) return att;
  return {
    ...att,
    ...(heavyMain ? { fileUrl: `/api/attachments/${att.id}` } : {}),
    // Thumb inline pesado cai pro arquivo principal via proxy (render integral).
    ...(heavyThumb ? { thumbnailUrl: `/api/attachments/${att.id}` } : {}),
  };
}

export function sanitizeMessageAttachments<
  T extends { attachments?: ApiAttachmentShape[] | null },
>(msg: T): T {
  const atts = msg.attachments;
  if (!Array.isArray(atts) || atts.length === 0) return msg;
  if (!atts.some((a) => isHeavyInline(a.fileUrl) || isHeavyInline(a.thumbnailUrl))) {
    return msg;
  }
  return { ...msg, attachments: atts.map(sanitizeAttachmentForApi) };
}
