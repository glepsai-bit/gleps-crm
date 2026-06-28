/**
 * T-023 V2 — EvolutionService tests
 *
 * Cobre os 4 novos metodos de envio multi-tipo:
 *   - sendMedia (image/video/document)
 *   - sendAudio (PTT)
 *   - sendSticker (WEBP)
 *   - sendReaction (emoji em msg existente)
 *
 * NUNCA bate na API real — mockamos global.fetch e o getAccountConfig
 * via setup de Account de teste no Postgres (suite ja inicializa prismaTest).
 *
 * Regra QA: WhatsApp REAL so para 5534993383017; aqui usamos numeros
 * arbitrarios pois nada eh enviado de fato (fetch mockado).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { prismaTest } from '../test/setup';
import { evolutionService } from './evolution.service';

beforeEach(() => {
  vi.restoreAllMocks();
});

async function createAccountWithEvolution() {
  return prismaTest.account.create({
    data: {
      nome: 'Evo Test',
      timezone: 'America/Sao_Paulo',
      evolutionBaseUrl: 'https://evo-test.example.com',
      evolutionApiKey: 'test-api-key',
      evolutionInstance: 'inst-test',
    },
  });
}

function mockFetchOnce(body: any, status = 200) {
  const fetchMock = vi.fn(
    async (_url: string, _opts?: any) =>
      ({
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      }) as any,
  );
  // @ts-ignore
  global.fetch = fetchMock;
  return fetchMock;
}

describe('evolutionService.sendMedia', () => {
  it('forma payload correto e retorna messageId', async () => {
    const acc = await createAccountWithEvolution();
    const fetchMock = mockFetchOnce({ key: { id: 'evo-media-id-1' } });

    const out = await evolutionService.sendMedia(acc.id, {
      number: '5534993383017',
      mediaType: 'image',
      mediaUrl: 'data:image/jpeg;base64,AAAA',
      caption: 'legenda',
    });

    expect(out.messageId).toBe('evo-media-id-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/message/sendMedia/inst-test');
    const body = JSON.parse((opts as any).body);
    expect(body.number).toBe('5534993383017');
    expect(body.mediatype).toBe('image');
    expect(body.media).toBe('data:image/jpeg;base64,AAAA');
    expect(body.caption).toBe('legenda');
  });

  it('rejeita mediaUrl invalido (nao http nem data:)', async () => {
    const acc = await createAccountWithEvolution();
    await expect(
      evolutionService.sendMedia(acc.id, {
        number: '5534993383017',
        mediaType: 'image',
        mediaUrl: 'AAAA-base64-puro-invalido',
      }),
    ).rejects.toThrow(/mediaUrl inválido/);
  });
});

describe('evolutionService.sendAudio', () => {
  it('forma payload correto e retorna messageId', async () => {
    const acc = await createAccountWithEvolution();
    const fetchMock = mockFetchOnce({ key: { id: 'evo-audio-id-1' } });

    const out = await evolutionService.sendAudio(acc.id, {
      number: '5534993383017',
      audioUrl: 'data:audio/ogg;base64,BBBB',
    });

    expect(out.messageId).toBe('evo-audio-id-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/message/sendWhatsAppAudio/inst-test');
    const body = JSON.parse((opts as any).body);
    expect(body.number).toBe('5534993383017');
    expect(body.audio).toBe('data:audio/ogg;base64,BBBB');
  });
});

describe('evolutionService.sendSticker', () => {
  it('forma payload correto e retorna messageId', async () => {
    const acc = await createAccountWithEvolution();
    const fetchMock = mockFetchOnce({ key: { id: 'evo-sticker-id-1' } });

    const out = await evolutionService.sendSticker(acc.id, {
      number: '5534993383017',
      sticker: 'https://cdn.example.com/sticker.webp',
    });

    expect(out.messageId).toBe('evo-sticker-id-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/message/sendSticker/inst-test');
    const body = JSON.parse((opts as any).body);
    expect(body.number).toBe('5534993383017');
    expect(body.sticker).toBe('https://cdn.example.com/sticker.webp');
  });

  it('throws se sticker vazio', async () => {
    const acc = await createAccountWithEvolution();
    await expect(
      evolutionService.sendSticker(acc.id, {
        number: '5534993383017',
        sticker: '',
      }),
    ).rejects.toThrow(/sticker é obrigatório/);
  });
});

describe('evolutionService.sendReaction', () => {
  it('forma payload correto com reactionMessage envelope', async () => {
    const acc = await createAccountWithEvolution();
    const fetchMock = mockFetchOnce({ key: { id: 'evo-reaction-id-1' } });

    const out = await evolutionService.sendReaction(acc.id, {
      number: '5534993383017',
      reaction: '👍',
      reactionToMsgId: 'msg-id-anterior',
    });

    expect(out.messageId).toBe('evo-reaction-id-1');
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('/message/sendReaction/inst-test');
    const body = JSON.parse((opts as any).body);
    expect(body.reactionMessage).toBeDefined();
    expect(body.reactionMessage.reaction).toBe('👍');
    expect(body.reactionMessage.key.id).toBe('msg-id-anterior');
    expect(body.reactionMessage.key.remoteJid).toBe('5534993383017@s.whatsapp.net');
    expect(body.reactionMessage.key.fromMe).toBe(false);
  });

  it('throws se reactionToMsgId vazio', async () => {
    const acc = await createAccountWithEvolution();
    await expect(
      evolutionService.sendReaction(acc.id, {
        number: '5534993383017',
        reaction: '👍',
        reactionToMsgId: '',
      }),
    ).rejects.toThrow(/reactionToMsgId é obrigatório/);
  });

  it('throws se reaction vazia', async () => {
    const acc = await createAccountWithEvolution();
    await expect(
      evolutionService.sendReaction(acc.id, {
        number: '5534993383017',
        reaction: '',
        reactionToMsgId: 'msg-id',
      }),
    ).rejects.toThrow(/reaction é obrigatório/);
  });
});

describe('evolutionService — retorno consistente em todos os sends', () => {
  it('todos os sends retornam { messageId, raw } no mesmo shape', async () => {
    const acc = await createAccountWithEvolution();

    mockFetchOnce({ key: { id: 'id-text' } });
    const text = await evolutionService.sendText(acc.id, {
      number: '5534993383017',
      text: 'oi',
    });
    expect(text).toHaveProperty('messageId');
    expect(text).toHaveProperty('raw');

    mockFetchOnce({ key: { id: 'id-media' } });
    const media = await evolutionService.sendMedia(acc.id, {
      number: '5534993383017',
      mediaType: 'image',
      mediaUrl: 'data:image/jpeg;base64,AAAA',
    });
    expect(media).toHaveProperty('messageId');
    expect(media).toHaveProperty('raw');

    mockFetchOnce({ key: { id: 'id-audio' } });
    const audio = await evolutionService.sendAudio(acc.id, {
      number: '5534993383017',
      audioUrl: 'data:audio/ogg;base64,AAAA',
    });
    expect(audio).toHaveProperty('messageId');
    expect(audio).toHaveProperty('raw');

    mockFetchOnce({ key: { id: 'id-sticker' } });
    const sticker = await evolutionService.sendSticker(acc.id, {
      number: '5534993383017',
      sticker: 'https://cdn.example.com/s.webp',
    });
    expect(sticker).toHaveProperty('messageId');
    expect(sticker).toHaveProperty('raw');

    mockFetchOnce({ key: { id: 'id-reaction' } });
    const reaction = await evolutionService.sendReaction(acc.id, {
      number: '5534993383017',
      reaction: '👍',
      reactionToMsgId: 'm',
    });
    expect(reaction).toHaveProperty('messageId');
    expect(reaction).toHaveProperty('raw');
  });
});
