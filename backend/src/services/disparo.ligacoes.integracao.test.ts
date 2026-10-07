/**
 * Disparos — as LIGAÇÕES no webhook da Evolution e nas rotas (QA).
 *
 * disparo.integracao.test.ts prova o motor chamando o serviço direto; aqui
 * provamos que o webhook de verdade chama o serviço: ack READ sobe o envio
 * para 'lida', a primeira resposta marca 'respondeu', conversa com
 * human_active não aciona o fluxo de IA, e as rotas respeitam o módulo.
 * Só a Evolution é mockada.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const evolutionMock = vi.hoisted(() => {
  let n = 0;
  return {
    sendText: vi.fn(async () => ({ messageId: `evo-lig-${++n}`, raw: {} })),
    getStatus: vi.fn(async () => ({ state: 'open', raw: {} })),
    sendMedia: vi.fn(async () => ({ messageId: `media-${++n}`, raw: {} })),
    sendWhatsAppAudio: vi.fn(async () => ({ messageId: `audio-${++n}`, raw: {} })),
    getConnectedNumber: vi.fn(async () => null),
    markMessageAsRead: vi.fn(async () => true),
    sendPresence: vi.fn(async () => true),
    fetchProfilePictureUrl: vi.fn(async () => null),
  };
});
vi.mock('./evolution.service', () => ({
  evolutionService: evolutionMock,
  extractConnectedNumber: () => null,
}));

import { prisma } from '../config/database';
import { createTestAccount, authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { disparoService } from './disparo.service';
import { flowService } from './flow.service';
import { rodadaDeDisparos, __definirEspera, __limparCacheDeInbox } from './disparo.worker';

const app = createTestApp();

async function comRetry<T>(fn: () => Promise<T>, tentativas = 12): Promise<T> {
  let ultimo: unknown;
  for (let i = 0; i < tentativas; i++) {
    try {
      return await fn();
    } catch (err) {
      const codigo = (err as { code?: string }).code;
      if (codigo !== 'P2003' && codigo !== 'P2025') throw err;
      ultimo = err;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
  throw ultimo;
}

const TEL = '5511987654321';

/** Conta + inbox + disparo "agora" já enviado pelo worker (Evolution mockada). */
async function disparoEnviado(atende: 'agente' | 'humano') {
  const { account, jwt } = await createTestAccount();
  const inbox = await comRetry(() =>
    prisma.inbox.create({
      data: { accountId: account.id, name: 'Comercial', channelType: 'whatsapp', evolutionInstance: 'inst-lig', active: true },
    })
  );
  const d = await disparoService.criar(account.id, null, {
    texto: 'oi {{nome}}',
    lista: { tipo: 'numeros', linhas: [`Maria;${TEL}`] },
    inboxIds: [inbox.id],
    atendeRespostas: atende,
  });
  const envio0 = await prisma.disparoEnvio.findFirstOrThrow({ where: { disparoId: d.id } });
  await prisma.disparoEnvio.update({ where: { id: envio0.id }, data: { naoAntesDe: new Date(Date.now() - 1000) } });
  await rodadaDeDisparos();
  const envio = await prisma.disparoEnvio.findFirstOrThrow({ where: { disparoId: d.id } });
  expect(envio.status).toBe('enviada');
  expect(envio.evolutionMsgId).toMatch(/^evo-lig-/);
  return { account, jwt, inbox, d, envio };
}

const upsert = (id: string, texto: string) => ({
  event: 'messages.upsert',
  instance: 'inst-lig',
  data: { key: { remoteJid: `${TEL}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Maria', message: { conversation: texto } },
});

/** O webhook dispara os ganchos com `void`; espera o banco refletir. */
async function ate<T>(ler: () => Promise<T>, ok: (v: T) => boolean, tentativas = 40): Promise<T> {
  let v = await ler();
  for (let i = 0; i < tentativas && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 50));
    v = await ler();
  }
  return v;
}

beforeEach(() => {
  vi.restoreAllMocks();
  __limparCacheDeInbox();
  __definirEspera(async () => undefined);
});

describe('ligações do disparo no webhook', () => {
  it('ack READ do messages.update sobe o envio para "lida"', async () => {
    const { account, envio } = await disparoEnviado('agente');
    const res = await request(app)
      .post(`/api/evolution/webhook/${account.id}`)
      .send({
        event: 'messages.update',
        instance: 'inst-lig',
        data: { key: { remoteJid: `${TEL}@s.whatsapp.net`, fromMe: true, id: envio.evolutionMsgId }, status: 'READ' },
      });
    expect(res.status).toBe(200);
    const depois = await ate(
      () => prisma.disparoEnvio.findUniqueOrThrow({ where: { id: envio.id } }),
      (e) => e.status === 'lida'
    );
    expect(depois.status).toBe('lida');
  });

  it('inbound de contato com conversa de disparo marca "respondeu" e incrementa respondidas', async () => {
    const { account, d, envio } = await disparoEnviado('agente');
    const flow = vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);
    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('in-1', 'tenho interesse'));
    expect(res.status).toBe(200);
    const e = await ate(
      () => prisma.disparoEnvio.findUniqueOrThrow({ where: { id: envio.id } }),
      (x) => x.status === 'respondeu'
    );
    expect(e.status).toBe('respondeu');
    expect(e.respondidoEm).not.toBeNull();
    expect((await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } })).respondidas).toBe(1);
    // Modo agente: o fluxo de IA é acionado.
    expect(flow).toHaveBeenCalledTimes(1);

    // Segunda resposta não conta de novo.
    await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('in-2', 'e o preço?'));
    await new Promise((r) => setTimeout(r, 300));
    expect((await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } })).respondidas).toBe(1);
  });

  it('conversa com human_active=true (quem atende: fila humana) NÃO aciona o fluxo de IA, mas conta a resposta', async () => {
    const { account, d, envio } = await disparoEnviado('humano');
    const flow = vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);
    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('in-h', 'quero falar com alguém'));
    expect(res.status).toBe(200);
    const e = await ate(
      () => prisma.disparoEnvio.findUniqueOrThrow({ where: { id: envio.id } }),
      (x) => x.status === 'respondeu'
    );
    expect(e.status).toBe('respondeu');
    expect((await prisma.disparo.findUniqueOrThrow({ where: { id: d.id } })).respondidas).toBe(1);
    expect(flow).not.toHaveBeenCalled();
  });
});

describe('módulos nas rotas', () => {
  it('GET /api/aquecimento e /api/disparos: 200 com o módulo ligado, 403 MODULO_DESLIGADO desligado', async () => {
    const { account, jwt } = await createTestAccount();
    for (const rota of ['/api/aquecimento', '/api/disparos']) {
      const ok = await request(app).get(rota).set(authHeader(jwt));
      expect(ok.status, `${rota} ligado: ${JSON.stringify(ok.body)}`).toBe(200);
    }
    await comRetry(() => prisma.account.update({ where: { id: account.id }, data: { modulos: [] } }));
    for (const rota of ['/api/aquecimento', '/api/disparos']) {
      const off = await request(app).get(rota).set(authHeader(jwt));
      expect(off.status, rota).toBe(403);
      expect(JSON.stringify(off.body)).toContain('MODULO_DESLIGADO');
    }
  });
});
