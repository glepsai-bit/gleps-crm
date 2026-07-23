/**
 * whatsapp-media.util — parsing de mensagens inbound do Baileys/Evolution.
 *
 * Extraído de evolution.controller.extractMessagePayload (era método privado,
 * puro, sem cobertura de teste) para poder ser testado isoladamente e para
 * concentrar as regras de classificação de mídia num só lugar.
 *
 * Correções embutidas (bug de mídia sumindo do chat):
 *  - Bug 2 (FIX-VIDEO-AS-DOCUMENT): vídeo/imagem/áudio enviados COMO ARQUIVO
 *    (.mp4/.mov/...) chegam como `documentMessage`. Classificamos pelo mimetype
 *    para renderizar player nativo, não um link de download.
 *  - Bug 3 (FIX-MEDIA-NEVER-DROP): nunca descartar um nó de mídia. Antes, sem
 *    URL http E sem mediaKey no payload, o anexo era retornado null → a mensagem
 *    inteira era pulada (o controller ignora msg sem content nem attachment) e
 *    a mídia sumia. Agora, sem URL http, usamos o sentinel — o materialize
 *    descriptografa via getBase64FromMediaMessage pelo externalId da mensagem
 *    (a Evolution recupera a mediaKey do próprio store, inclusive em echo
 *    fromMe sem mediaKey no payload).
 */
import { WA_ENCRYPTED_MEDIA_SENTINEL } from '../services/attachment-storage.service';
import type {
  MessageContentType,
  CreateAttachmentInput,
} from '../services/message.service';

export interface ExtractedMessagePayload {
  content: string | null;
  contentType: MessageContentType;
  attachments: CreateAttachmentInput[];
}

type MediaFileType = CreateAttachmentInput['fileType'];

/**
 * Deriva o fileType real de um documento pelo mimetype. WhatsApp entrega
 * arquivos (.mp4/.mov/.jpg/...) como documentMessage; sem isto um vídeo
 * enviado como arquivo era tratado como 'document' e não tocava.
 */
function fileTypeFromMime(mime: string | null | undefined): MediaFileType | null {
  const m = (mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  return null;
}

/**
 * Constrói um CreateAttachmentInput a partir de um nó de mídia do Baileys.
 * NUNCA retorna null quando há um nó de mídia real (Bug 3): sem URL http,
 * usa o sentinel, que o materialize resolve via getBase64FromMediaMessage.
 */
function buildAttachment(
  fileType: MediaFileType,
  node: any
): CreateAttachmentInput | null {
  if (!node || typeof node !== 'object') return null;

  const rawUrl: string | undefined =
    node.url || node.mediaUrl || node.directPath || node.downloadUrl;
  const isHttpUrl = typeof rawUrl === 'string' && /^https?:\/\//i.test(rawUrl);

  // Bug 3: sem URL http → sentinel (decrypt pelo externalId no materialize),
  // em vez de descartar. Vale para mídia cifrada do WhatsApp e para echo
  // fromMe (o Baileys nem sempre popula url/mediaKey no eco de saída).
  const sourceUrl = isHttpUrl ? (rawUrl as string) : WA_ENCRYPTED_MEDIA_SENTINEL;

  return {
    fileType,
    // fileUrl recebe a URL fonte só como placeholder; o message.service grava
    // em sourceUrl e dispara materialize(); depois vira '/api/attachments/<id>'.
    fileUrl: sourceUrl,
    sourceUrl,
    fileName: node.fileName ?? null,
    mimeType: node.mimetype ?? node.mimeType ?? null,
    fileSize:
      typeof node.fileLength === 'number'
        ? node.fileLength
        : typeof node.fileSize === 'number'
          ? node.fileSize
          : null,
    thumbnailUrl: node.jpegThumbnail || node.thumbnailUrl || null,
    duration: typeof node.seconds === 'number' ? node.seconds : null,
  } as CreateAttachmentInput;
}

/**
 * Converte a `message` crua do Baileys num payload normalizado do CRM.
 * Ordem dos handlers preservada do original (texto → mídia → localização →
 * contato → fallback vazio).
 */
export function extractWhatsappMessagePayload(
  rawMessage: any
): ExtractedMessagePayload {
  const m = rawMessage || {};

  // texto puro
  if (typeof m.conversation === 'string' && m.conversation.length > 0) {
    return { content: m.conversation, contentType: 'text', attachments: [] };
  }
  if (typeof m.extendedTextMessage?.text === 'string') {
    return {
      content: m.extendedTextMessage.text,
      contentType: 'text',
      attachments: [],
    };
  }

  if (m.imageMessage) {
    const att = buildAttachment('image', m.imageMessage);
    return {
      content: m.imageMessage.caption ?? null,
      contentType: 'media',
      attachments: att ? [att] : [],
    };
  }

  if (m.videoMessage) {
    const att = buildAttachment('video', m.videoMessage);
    return {
      content: m.videoMessage.caption ?? null,
      contentType: 'media',
      attachments: att ? [att] : [],
    };
  }

  if (m.documentMessage) {
    // Bug 2: classifica pelo mimetype. .mp4/.mov como arquivo → 'video'.
    const mime = m.documentMessage.mimetype ?? m.documentMessage.mimeType ?? null;
    const mediaType = fileTypeFromMime(mime);
    const fileType: MediaFileType = mediaType ?? 'document';
    const att = buildAttachment(fileType, m.documentMessage);
    return {
      // Se é mídia de verdade (vídeo/imagem/áudio), não jogamos o fileName como
      // texto — só a caption. Só documento "real" usa o fileName como conteúdo.
      content:
        m.documentMessage.caption ??
        (mediaType ? null : (m.documentMessage.fileName ?? null)),
      contentType: mediaType ? 'media' : 'document',
      attachments: att ? [att] : [],
    };
  }

  if (m.audioMessage) {
    const att = buildAttachment('audio', m.audioMessage);
    return { content: null, contentType: 'audio', attachments: att ? [att] : [] };
  }

  if (m.stickerMessage) {
    const att = buildAttachment('sticker', m.stickerMessage);
    return { content: null, contentType: 'media', attachments: att ? [att] : [] };
  }

  // localização (estática ou ao vivo) → texto com link do Google Maps
  const loc = m.locationMessage || m.liveLocationMessage;
  if (loc && typeof loc === 'object') {
    const lat = loc.degreesLatitude ?? loc.latitude;
    const lng = loc.degreesLongitude ?? loc.longitude;
    if (typeof lat === 'number' && typeof lng === 'number') {
      const label = loc.name || loc.address || 'Localização';
      const maps = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
      const extra = loc.address && loc.address !== loc.name ? `\n${loc.address}` : '';
      return {
        content: `📍 ${label}${extra}\n${maps}`,
        contentType: 'text',
        attachments: [],
      };
    }
  }

  // contato compartilhado (vCard) → texto com nome + telefone
  const contactMsg = m.contactMessage;
  if (contactMsg && typeof contactMsg === 'object') {
    const dn = contactMsg.displayName || 'Contato';
    const phone = (contactMsg.vcard || '').match(/waid=([0-9]+)/)?.[1];
    return {
      content: `👤 ${dn}${phone ? `\n+${phone}` : ''}`,
      contentType: 'text',
      attachments: [],
    };
  }

  return { content: null, contentType: 'text', attachments: [] };
}
