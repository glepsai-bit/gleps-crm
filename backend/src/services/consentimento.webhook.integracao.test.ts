/**
 * ETAPA E — SAIR / VOLTAR no webhook da Evolution, contra o Postgres de verdade.
 *
 * Prova a ligação inteira: "SAIR" grava opted_out, a confirmação sai UMA vez
 * pela mesma inbox (Evolution mockada) e fica na conversa como mensagem de
 * sistema, e o fluxo de IA NÃO é acionado; "SAIR" de novo não confirma de
 * novo; "VOLTAR" reverte e confirma; falha no envio não desfaz o opt-out;
 * "quero receber" de quem nunca saiu segue pro atendimento normal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const evolutionMock = vi.hoisted(() => {
  let n = 0;
  return {
    sendText: vi.fn(async (_acc: string, _input: { number: string; text: string }) => ({ messageId: `evo-cons-${++n}`, raw: {} })),
    getStatus: vi.fn(async () => ({ state: 'open', raw: {} })),
    sendMedia: vi.fn(async () => ({ messageId: `media-${++n}`, raw: {} })),
    sendAudio: vi.fn(async () => ({ messageId: `audio-${++n}`, raw: {} })),
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
import { createTestAccount } from '../test/helpers';
import { createTestApp } from '../test/app';
import { flowService } from './flow.service';
import { MENSAGEM_DE_OPT_IN, MENSAGEM_DE_OPT_OUT } from './whatsapp-consent.service';

const app = createTestApp();
const TEL = '5511987654321';
const INSTANCE = 'inst-cons';

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

async function contaComInbox() {
  const { account } = await createTestAccount();
  const inbox = await comRetry(() =>
    prisma.inbox.create({
      data: { accountId: account.id, name: 'Comercial', channelType: 'whatsapp', evolutionInstance: INSTANCE, active: true },
    })
  );
  return { account, inbox };
}

const upsert = (id: string, texto: string) => ({
  event: 'messages.upsert',
  instance: INSTANCE,
  data: { key: { remoteJid: `${TEL}@s.whatsapp.net`, fromMe: false, id }, pushName: 'Maria', message: { conversation: texto } },
});

const consentimento = (accountId: string) =>
  prisma.whatsappConsent.findUnique({ where: { accountId_phone: { accountId, phone: TEL } } });

const mensagens = (accountId: string) =>
  prisma.message.findMany({
    where: { conversation: { accountId } },
    orderBy: { createdAt: 'asc' },
    select: { senderType: true, content: true, status: true, metadata: true },
  });

const assentar = () => new Promise((r) => setTimeout(r, 300));

beforeEach(() => {
  vi.restoreAllMocks();
  evolutionMock.sendText.mockClear();
});

describe('SAIR no webhook', () => {
  it('grava opted_out, confirma UMA vez pela mesma inbox como mensagem de sistema e não aciona o fluxo', async () => {
    const { account, inbox } = await contaComInbox();
    const flow = vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);

    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-1', 'SAIR'));
    expect(res.status).toBe(200);

    const c = await consentimento(account.id);
    expect(c).toMatchObject({ status: 'opted_out', source: 'auto_keyword' });
    expect(c?.reason).toContain('SAIR');

    // Confirmação: uma chamada à Evolution, pro número certo, pela instância da inbox.
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);
    expect(evolutionMock.sendText.mock.calls[0][1]).toMatchObject({ number: TEL, text: MENSAGEM_DE_OPT_OUT, instance: INSTANCE });

    // Na conversa: o SAIR do lead e a confirmação (sistema, enviada).
    const conv = await prisma.conversation.findFirstOrThrow({ where: { accountId: account.id, inboxId: inbox.id } });
    expect(conv.contactId).not.toBeNull();
    const msgs = await mensagens(account.id);
    expect(msgs.map((m) => [m.senderType, m.content, m.status])).toEqual([
      ['customer', 'SAIR', expect.any(String)],
      ['system', MENSAGEM_DE_OPT_OUT, 'sent'],
    ]);
    expect(msgs[1].metadata).toMatchObject({ source: 'consentimento', acao: 'opt_out' });

    await assentar();
    expect(flow).not.toHaveBeenCalled();

    // SAIR de novo: continua fora, nada é reenviado, fluxo continua quieto.
    await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-2', 'sair'));
    await assentar();
    expect((await consentimento(account.id))?.status).toBe('opted_out');
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);
    expect(await mensagens(account.id)).toHaveLength(3);
    expect(flow).not.toHaveBeenCalled();
  });

  it('falha ao enviar a confirmação não desfaz o opt-out (fica registrada como falha na conversa)', async () => {
    const { account } = await contaComInbox();
    vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);
    evolutionMock.sendText.mockRejectedValueOnce(new Error('Evolution fora do ar'));

    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-f', 'PARAR'));
    expect(res.status).toBe(200);
    expect((await consentimento(account.id))?.status).toBe('opted_out');
    const msgs = await mensagens(account.id);
    expect(msgs[1]).toMatchObject({ senderType: 'system', content: MENSAGEM_DE_OPT_OUT, status: 'failed' });
  });
});

describe('VOLTAR no webhook', () => {
  it('quem saiu volta: opted_in (auto_keyword), confirma uma vez e não aciona o fluxo', async () => {
    const { account } = await contaComInbox();
    const flow = vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);

    await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-1', 'SAIR'));
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(1);

    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-2', 'VOLTAR'));
    expect(res.status).toBe(200);
    expect(await consentimento(account.id)).toMatchObject({ status: 'opted_in', source: 'auto_keyword' });
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(2);
    expect(evolutionMock.sendText.mock.calls[1][1]).toMatchObject({ number: TEL, text: MENSAGEM_DE_OPT_IN });

    const msgs = await mensagens(account.id);
    expect(msgs.map((m) => [m.senderType, m.content])).toEqual([
      ['customer', 'SAIR'],
      ['system', MENSAGEM_DE_OPT_OUT],
      ['customer', 'VOLTAR'],
      ['system', MENSAGEM_DE_OPT_IN],
    ]);
    await assentar();
    expect(flow).not.toHaveBeenCalled();

    // Depois de voltar, a conversa é atendimento de novo.
    await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-3', 'quero agendar'));
    await assentar();
    expect(flow).toHaveBeenCalledTimes(1);
    expect(evolutionMock.sendText).toHaveBeenCalledTimes(2);
  });

  it('"quero receber" de quem nunca saiu é atendimento normal: sem registro, sem resposta, fluxo acionado', async () => {
    const { account } = await contaComInbox();
    const flow = vi.spyOn(flowService, 'onInboundMessage').mockResolvedValue(undefined as never);

    const res = await request(app).post(`/api/evolution/webhook/${account.id}`).send(upsert('m-1', 'quero receber'));
    expect(res.status).toBe(200);
    await assentar();
    expect(await consentimento(account.id)).toBeNull();
    expect(evolutionMock.sendText).not.toHaveBeenCalled();
    expect(flow).toHaveBeenCalledTimes(1);
    expect(await mensagens(account.id)).toHaveLength(1);
  });
});
