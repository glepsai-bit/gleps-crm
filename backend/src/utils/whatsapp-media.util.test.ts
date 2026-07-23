import { describe, it, expect } from 'vitest';
import { extractWhatsappMessagePayload } from './whatsapp-media.util';
import { WA_ENCRYPTED_MEDIA_SENTINEL } from '../services/attachment-storage.service';

/**
 * Regressão dos bugs de mídia sumindo do chat (recebimento WhatsApp):
 *  - Bug 2: vídeo/imagem enviados como ARQUIVO chegam como documentMessage e
 *    eram classificados 'document' (renderizavam link, não player).
 *  - Bug 3: mídia sem url http e sem mediaKey no payload era DESCARTADA
 *    (attachment null) → a mensagem inteira sumia.
 */
describe('extractWhatsappMessagePayload', () => {
  it('texto puro (conversation)', () => {
    const r = extractWhatsappMessagePayload({ conversation: 'oi' });
    expect(r).toEqual({ content: 'oi', contentType: 'text', attachments: [] });
  });

  it('extendedTextMessage', () => {
    const r = extractWhatsappMessagePayload({ extendedTextMessage: { text: 'ola' } });
    expect(r.content).toBe('ola');
    expect(r.contentType).toBe('text');
    expect(r.attachments).toHaveLength(0);
  });

  it('imageMessage com url http vira image/media', () => {
    const r = extractWhatsappMessagePayload({
      imageMessage: { url: 'https://mmg.whatsapp.net/x.enc', caption: 'foto', mimetype: 'image/jpeg' },
    });
    expect(r.contentType).toBe('media');
    expect(r.content).toBe('foto');
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].fileType).toBe('image');
  });

  it('videoMessage com mediaKey mas sem url → video + sentinel (não descarta)', () => {
    const r = extractWhatsappMessagePayload({
      videoMessage: { mediaKey: 'abc==', mimetype: 'video/mp4', seconds: 12 },
    });
    expect(r.contentType).toBe('media');
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].fileType).toBe('video');
    expect(r.attachments[0].sourceUrl).toBe(WA_ENCRYPTED_MEDIA_SENTINEL);
    expect(r.attachments[0].duration).toBe(12);
  });

  // ── Bug 2 ──
  it('documentMessage com mimetype video/mp4 → fileType VIDEO (não document)', () => {
    const r = extractWhatsappMessagePayload({
      documentMessage: {
        fileName: '0528.mp4',
        mimetype: 'video/mp4',
        url: 'https://mmg.whatsapp.net/v/xxx',
      },
    });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].fileType).toBe('video');
    expect(r.contentType).toBe('media');
    // não joga o fileName como texto quando é mídia de verdade
    expect(r.content).toBeNull();
  });

  it('documentMessage com mimetype video/quicktime (.MOV) → fileType VIDEO', () => {
    const r = extractWhatsappMessagePayload({
      documentMessage: { fileName: 'IMG_5455.MOV', mimetype: 'video/quicktime', mediaKey: 'k==' },
    });
    expect(r.attachments[0].fileType).toBe('video');
    expect(r.attachments[0].sourceUrl).toBe(WA_ENCRYPTED_MEDIA_SENTINEL);
  });

  it('documentMessage com application/pdf continua document (fileName como conteúdo)', () => {
    const r = extractWhatsappMessagePayload({
      documentMessage: { fileName: 'contrato.pdf', mimetype: 'application/pdf', url: 'https://x/y' },
    });
    expect(r.attachments[0].fileType).toBe('document');
    expect(r.contentType).toBe('document');
    expect(r.content).toBe('contrato.pdf');
  });

  it('audioMessage → audio', () => {
    const r = extractWhatsappMessagePayload({
      audioMessage: { mediaKey: 'a==', mimetype: 'audio/ogg; codecs=opus' },
    });
    expect(r.contentType).toBe('audio');
    expect(r.attachments[0].fileType).toBe('audio');
  });

  it('stickerMessage → media/sticker', () => {
    const r = extractWhatsappMessagePayload({ stickerMessage: { mediaKey: 's==', mimetype: 'image/webp' } });
    expect(r.attachments[0].fileType).toBe('sticker');
    expect(r.content).toBeNull();
  });

  // ── Bug 3: o coração do "não some mais" ──
  it('videoMessage SEM url e SEM mediaKey → AINDA cria attachment (sentinel), não descarta', () => {
    const r = extractWhatsappMessagePayload({ videoMessage: { mimetype: 'video/mp4' } });
    expect(r.attachments).toHaveLength(1); // <- antes era 0 → msg sumia
    expect(r.attachments[0].fileType).toBe('video');
    expect(r.attachments[0].sourceUrl).toBe(WA_ENCRYPTED_MEDIA_SENTINEL);
  });

  it('documentMessage vazio (sem url/mediaKey) ainda cria attachment', () => {
    const r = extractWhatsappMessagePayload({ documentMessage: { fileName: 'x.mp4', mimetype: 'video/mp4' } });
    expect(r.attachments).toHaveLength(1);
    expect(r.attachments[0].fileType).toBe('video');
  });

  it('localização vira texto com link do Maps', () => {
    const r = extractWhatsappMessagePayload({
      locationMessage: { degreesLatitude: -19.9, degreesLongitude: -43.9, name: 'Loja' },
    });
    expect(r.contentType).toBe('text');
    expect(r.content).toContain('Loja');
    expect(r.content).toContain('google.com/maps');
    expect(r.attachments).toHaveLength(0);
  });

  it('contato (vCard) vira texto com telefone', () => {
    const r = extractWhatsappMessagePayload({
      contactMessage: { displayName: 'João', vcard: 'BEGIN:VCARD;waid=5534999999999;END' },
    });
    expect(r.content).toContain('João');
    expect(r.content).toContain('+5534999999999');
    expect(r.contentType).toBe('text');
  });

  it('mensagem desconhecida/vazia → text vazio sem attachment (será pulada pelo controller)', () => {
    const r = extractWhatsappMessagePayload({ someUnknownMessage: {} });
    expect(r).toEqual({ content: null, contentType: 'text', attachments: [] });
  });
});
