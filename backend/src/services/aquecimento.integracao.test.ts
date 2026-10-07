/**
 * Aquecimento — teste de INTEGRAÇÃO contra o Postgres de verdade.
 *
 * O unitário prova a regra; este prova que o motor roda sobre o schema real
 * (migration 0070) e que o webhook da Evolution deixa a conversa de
 * aquecimento fora do Chat. Só a Evolution é mockada.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

const evolutionMock = vi.hoisted(() => ({
  sendText: vi.fn(),
  markMessageAsRead: vi.fn(),
  sendPresence: vi.fn(),
  getStatus: vi.fn(),
  getConnectedNumber: vi.fn(),
  fetchProfilePictureUrl: vi.fn(async () => null),
}));
vi.mock('./evolution.service', () => ({
  evolutionService: evolutionMock,
  extractConnectedNumber: () => null,
}));

import { prisma } from '../config/database';
import { prismaTest } from '../test/setup';
import { createTestAccount, authHeader } from '../test/helpers';
import { createTestApp } from '../test/app';
import { aquecimentoService, RAMPA } from './aquecimento.service';

const app = createTestApp();

/** Mesmo retry do flow.integracao.test.ts: dois PrismaClient no mesmo banco após TRUNCATE. */
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

/** Hoje às 10:00 em São Paulo (UTC−3): dentro da janela, sem virada de dia. */
function hojeAs10() {
  const agora = new Date();
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate(), 13, 0, 0));
}

const TEL_A = '+5511999990001';
const TEL_B = '+5511999990002';

async function montarCenario(opts: { numeros?: number } = {}) {
  const { account, jwt } = await createTestAccount();
  const inboxA = await comRetry(() =>
    prisma.inbox.create({
      data: { accountId: account.id, name: 'WhatsApp A', channelType: 'whatsapp', evolutionInstance: 'inst-a', active: true },
    })
  );
  const inboxB = await comRetry(() =>
    prisma.inbox.create({
      data: { accountId: account.id, name: 'WhatsApp B', channelType: 'whatsapp', evolutionInstance: 'inst-b', active: true },
    })
  );
  const agora = hojeAs10();
  const quantos = opts.numeros ?? 2;
  const criar = (inbox: typeof inboxA, telefone: string) =>
    comRetry(() =>
      prisma.warmupNumber.create({
        data: {
          accountId: account.id,
          inboxId: inbox.id,
          evolutionInstance: inbox.evolutionInstance!,
          phoneE164: telefone,
          displayName: inbox.name,
          status: 'warming',
          currentDay: 1,
          dailyEnvioPlan: [...RAMPA],
          startedAt: agora,
          lastActivityAt: agora,
        },
      })
    );
  const numA = await criar(inboxA, TEL_A);
  const numB = quantos >= 2 ? await criar(inboxB, TEL_B) : null;
  return { account, jwt, inboxA, inboxB, numA, numB, agora };
}

beforeEach(() => {
  vi.clearAllMocks();
  aquecimentoService.aleatorio = () => 0.5;
  aquecimentoService.esquecerCache();
  let seq = 0;
  evolutionMock.sendText.mockImplementation(async () => ({ messageId: `evo-${++seq}`, raw: {} }));
  evolutionMock.markMessageAsRead.mockResolvedValue(true);
  evolutionMock.sendPresence.mockResolvedValue(true);
  evolutionMock.getStatus.mockResolvedValue({ state: 'open', raw: {} });
  evolutionMock.getConnectedNumber.mockImplementation(async (_c: string, inst: string) =>
    inst === 'inst-a' ? TEL_A : inst === 'inst-b' ? TEL_B : null
  );
});

describe('tick: a conversa nasce e a resposta é agendada', () => {
  it('abre conversa com a 1ª linha do roteiro, agenda o parceiro em 1–5 min e nada entra no Chat', async () => {
    const c = await montarCenario();

    const r = await aquecimentoService.rodar(c.agora);
    expect(r.novas).toBeGreaterThanOrEqual(1);
    expect(r.infra).toBe(0);

    const conv = await prismaTest.warmupConversation.findFirst({});
    expect(conv).not.toBeNull();
    expect(conv!.passo).toBe(1);
    expect(Array.isArray(conv!.roteiro)).toBe(true);
    expect(conv!.proximaRespostaEm).not.toBeNull();
    const atraso = conv!.proximaRespostaEm!.getTime() - c.agora.getTime();
    expect(atraso).toBeGreaterThanOrEqual(60_000);
    expect(atraso).toBeLessThanOrEqual(300_000);
    expect(conv!.ultimoMsgId).toMatch(/^evo-/);

    const msgs = await prismaTest.warmupMessage.findMany({});
    expect(msgs).toHaveLength(r.novas);
    expect(msgs[0].status).toBe('sent');

    const remetente = await prismaTest.warmupNumber.findUnique({ where: { id: msgs[0].senderId } });
    const destinatario = await prismaTest.warmupNumber.findUnique({ where: { id: msgs[0].receiverId } });
    expect(remetente!.dailyEnviadasHoje).toBe(1);
    expect(destinatario!.dailyRecebidasHoje).toBe(1);
    expect(conv!.proximoRemetenteId).toBe(destinatario!.id);

    // O Chat não ganha nada.
    expect(await prismaTest.contact.count()).toBe(0);
    expect(await prismaTest.conversation.count()).toBe(0);
    expect(await prismaTest.message.count()).toBe(0);

    // Na hora marcada, o parceiro lê, "digita" e responde a 2ª linha.
    evolutionMock.sendText.mockClear();
    await aquecimentoService.rodar(new Date(conv!.proximaRespostaEm!.getTime() + 1000));
    expect(evolutionMock.markMessageAsRead).toHaveBeenCalledWith(
      c.account.id,
      expect.objectContaining({ id: conv!.ultimoMsgId, instance: destinatario!.evolutionInstance })
    );
    expect(evolutionMock.sendPresence).toHaveBeenCalledWith(
      c.account.id,
      expect.objectContaining({ presence: 'composing', instance: destinatario!.evolutionInstance })
    );
    const resposta = evolutionMock.sendText.mock.calls.find(
      ([, input]) => (input as { instance: string }).instance === destinatario!.evolutionInstance
    );
    expect(resposta).toBeDefined();
    expect((resposta![1] as { text: string }).text).toBe((conv!.roteiro as string[])[1]);
    const depois = await prismaTest.warmupConversation.findUnique({ where: { id: conv!.id } });
    expect(depois!.passo).toBe(2);
    expect(depois!.proximoRemetenteId).toBe(remetente!.id);
  });

  it('com um só número, nada sai (aguardando parceiro) e a API mostra isso', async () => {
    const c = await montarCenario({ numeros: 1 });
    const r = await aquecimentoService.rodar(c.agora);
    expect(r.novas).toBe(0);
    expect(evolutionMock.sendText).not.toHaveBeenCalled();

    const res = await request(app).get('/api/aquecimento').set(authHeader(c.jwt));
    expect(res.status).toBe(200);
    expect(res.body.data.numeros).toHaveLength(1);
    expect(res.body.data.numeros[0]).toMatchObject({
      status: 'aguardando_parceiro',
      inboxId: c.inboxA.id,
      inboxNome: 'WhatsApp A',
      telefone: TEL_A,
      dia: 1,
      hoje: { planejadas: 10, enviadas: 0, recebidas: 0, disparos: 0 },
    });
    expect(res.body.data.agora.janela.fuso).toBe('America/Sao_Paulo');
  });

  it('fora da janela e com a conta pausada por infra, nada sai', async () => {
    const c = await montarCenario();
    const madrugada = new Date(c.agora.getTime() - 8 * 60 * 60 * 1000); // 02:00 SP
    await aquecimentoService.rodar(madrugada);
    expect(evolutionMock.sendText).not.toHaveBeenCalled();

    await prisma.account.update({
      where: { id: c.account.id },
      data: { warmupInfraPausaAte: new Date(c.agora.getTime() + 10 * 60 * 1000) },
    });
    await aquecimentoService.rodar(c.agora);
    expect(evolutionMock.sendText).not.toHaveBeenCalled();
  });

  it('tick() com o advisory lock roda e devolve a rodada', async () => {
    const c = await montarCenario();
    const r = await aquecimentoService.tick(c.agora);
    expect(r.pulado).toBe(false);
    expect(r.contas).toBe(1);
  });
});

describe('falhas', () => {
  it('infra pausa a conta por 15 min sem tocar no número, e volta a tentar depois', async () => {
    const c = await montarCenario();
    evolutionMock.sendText.mockRejectedValue(
      new Error('Falha na comunicação com Evolution API: The operation was aborted due to timeout')
    );

    const r = await aquecimentoService.rodar(c.agora);
    expect(r.infra).toBe(1);

    const conta = await prismaTest.account.findUnique({ where: { id: c.account.id } });
    expect(conta!.warmupInfraPausaAte!.getTime()).toBe(c.agora.getTime() + 15 * 60 * 1000);

    for (const id of [c.numA.id, c.numB!.id]) {
      const n = await prismaTest.warmupNumber.findUnique({ where: { id } });
      expect(n!.status).toBe('warming');
      expect(n!.falhasSeguidas).toBe(0);
      expect(n!.dailyEnviadasHoje).toBe(0);
    }
    expect(await prismaTest.warmupMessage.count({ where: { status: 'failed' } })).toBe(0);

    // Durante a pausa: silêncio. Depois dela: tenta de novo.
    evolutionMock.sendText.mockClear();
    await aquecimentoService.rodar(new Date(c.agora.getTime() + 5 * 60 * 1000));
    expect(evolutionMock.sendText).not.toHaveBeenCalled();
    evolutionMock.sendText.mockImplementation(async () => ({ messageId: 'evo-volta', raw: {} }));
    await aquecimentoService.rodar(new Date(c.agora.getTime() + 16 * 60 * 1000));
    expect(evolutionMock.sendText).toHaveBeenCalled();
  });

  it('5 falhas de número pausam só ele; retomar zera e mantém o dia', async () => {
    const c = await montarCenario();
    await prisma.warmupNumber.update({ where: { id: c.numA.id }, data: { falhasSeguidas: 4, currentDay: 6 } });
    // B já cumpriu a cota do dia: só A tenta abrir conversa nesta rodada.
    await prisma.warmupNumber.update({ where: { id: c.numB!.id }, data: { dailyEnviadasHoje: 10 } });
    // Só a instância A falha; B responde normalmente.
    evolutionMock.sendText.mockImplementation(async (_c: string, input: { instance: string }) => {
      if (input.instance === 'inst-a') throw new Error('Evolution API retornou status 400');
      return { messageId: 'evo-b', raw: {} };
    });

    const r = await aquecimentoService.rodar(c.agora);
    expect(r.falhas).toBe(1);

    const a = await prismaTest.warmupNumber.findUnique({ where: { id: c.numA.id } });
    expect(a!.status).toBe('paused');
    expect(a!.falhasSeguidas).toBe(5);
    expect(a!.pausedReason).toBe('5 falhas seguidas no envio');
    expect(a!.pausadoEm).not.toBeNull();
    const b = await prismaTest.warmupNumber.findUnique({ where: { id: c.numB!.id } });
    expect(b!.status).toBe('warming');
    const conta = await prismaTest.account.findUnique({ where: { id: c.account.id } });
    expect(conta!.warmupInfraPausaAte).toBeNull();

    const res = await request(app).post(`/api/aquecimento/numeros/${c.numA.id}/retomar`).set(authHeader(c.jwt));
    expect(res.status).toBe(200);
    expect(res.body.data.numero).toMatchObject({ status: 'aquecendo', dia: 6, falhasSeguidas: 0, saude: 'boa', pausadoMotivo: null });
  });

  it('dia 31 vira Pronto com limite 200 e capacidadeDoNumero bate', async () => {
    const c = await montarCenario();
    const ontem = new Date(c.agora.getTime() - 24 * 60 * 60 * 1000);
    await prisma.warmupNumber.update({
      where: { id: c.numA.id },
      data: { currentDay: 30, lastActivityAt: ontem, dailyEnviadasHoje: 150, disparosHoje: 40 },
    });

    await aquecimentoService.rodar(c.agora);

    const a = await prismaTest.warmupNumber.findUnique({ where: { id: c.numA.id } });
    expect(a).toMatchObject({ status: 'warm', modo: 'manutencao', currentDay: 31, disparosHoje: 0 });
    expect(a!.prontoEm).not.toBeNull();
    const stats = await prismaTest.warmupDailyStats.findMany({ where: { numberId: c.numA.id } });
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({ protocolDay: 30, plannedSends: 200, actualSends: 150 });

    await aquecimentoService.registrarEnvioExterno(c.account.id, c.inboxA.id, 25);
    const cap = await aquecimentoService.capacidadeDoNumero(c.account.id, c.inboxA.id);
    const enviadasHoje = (await prismaTest.warmupNumber.findUnique({ where: { id: c.numA.id } }))!.dailyEnviadasHoje;
    expect(cap).toEqual({ status: 'pronto', dia: 30, limiteDiario: 200, restantesHoje: 200 - 25 - enviadasHoje });
    expect(await aquecimentoService.capacidadeDoNumero(c.account.id, '99999999-9999-4999-8999-999999999999')).toEqual({
      status: 'nao_aquecido',
      dia: 0,
      limiteDiario: 50,
      restantesHoje: 50,
    });
  });
});

describe('webhook da Evolution', () => {
  const upsert = (instance: string, remoteJid: string, id: string, fromMe: boolean, texto = 'oi, tudo bem?') => ({
    event: 'messages.upsert',
    instance,
    data: { key: { remoteJid, fromMe, id }, pushName: 'Alguém', message: { conversation: texto } },
  });

  it('inbound de número de aquecimento não cria contato/conversa/mensagem e marca a WarmupMessage como entregue', async () => {
    const c = await montarCenario();
    await aquecimentoService.rodar(c.agora);
    const enviada = await prismaTest.warmupMessage.findFirst({});
    const destinatario = (await prismaTest.warmupNumber.findUnique({ where: { id: enviada!.receiverId } }))!;
    const remetente = (await prismaTest.warmupNumber.findUnique({ where: { id: enviada!.senderId } }))!;

    // A instância de quem recebeu vê a mensagem chegar do número que mandou.
    const res = await request(app)
      .post(`/api/evolution/webhook/${c.account.id}`)
      .send(upsert(destinatario.evolutionInstance, `${remetente.phoneE164.slice(1)}@s.whatsapp.net`, enviada!.evolutionMsgId!, false));
    expect(res.status).toBe(200);

    expect(await prismaTest.contact.count()).toBe(0);
    expect(await prismaTest.conversation.count()).toBe(0);
    expect(await prismaTest.message.count()).toBe(0);
    expect(await prismaTest.whatsappConsent.count()).toBe(0);
    const entregue = await prismaTest.warmupMessage.findUnique({ where: { id: enviada!.id } });
    expect(entregue!.status).toBe('delivered');
    // Recebidas não dobra: já foi contada no envio.
    expect((await prismaTest.warmupNumber.findUnique({ where: { id: destinatario.id } }))!.dailyRecebidasHoje).toBe(1);

    // O eco fromMe na instância de quem mandou também fica fora do Chat.
    const eco = await request(app)
      .post(`/api/evolution/webhook/${c.account.id}`)
      .send(upsert(remetente.evolutionInstance, `${destinatario.phoneE164.slice(1)}@s.whatsapp.net`, enviada!.evolutionMsgId!, true));
    expect(eco.status).toBe(200);
    expect(await prismaTest.conversation.count()).toBe(0);

    // Mensagem de um cliente de verdade continua entrando.
    const cliente = await request(app)
      .post(`/api/evolution/webhook/${c.account.id}`)
      .send(upsert('inst-a', '5511988887777@s.whatsapp.net', 'msg-cliente', false, 'quero saber o preço'));
    expect(cliente.status).toBe(200);
    expect(await prismaTest.conversation.count()).toBe(1);
    expect(await prismaTest.message.count()).toBe(1);
  });
});

describe('API /api/aquecimento', () => {
  it('adicionar exige inbox conectada com telefone (400 em português), recusa repetida (409) e lista disponíveis', async () => {
    const { account, jwt } = await createTestAccount();
    const inbox = await comRetry(() =>
      prisma.inbox.create({
        data: { accountId: account.id, name: 'Novo', channelType: 'whatsapp', evolutionInstance: 'inst-nova', active: true },
      })
    );
    const semInstancia = await comRetry(() =>
      prisma.inbox.create({ data: { accountId: account.id, name: 'Sem QR', channelType: 'whatsapp', active: true } })
    );

    evolutionMock.getStatus.mockResolvedValueOnce({ state: 'close', raw: {} });
    const desconectada = await request(app).post('/api/aquecimento/numeros').set(authHeader(jwt)).send({ inboxId: inbox.id });
    expect(desconectada.status).toBe(400);
    expect(desconectada.body.error.message).toBe('O número precisa estar conectado para aquecer');

    evolutionMock.getConnectedNumber.mockResolvedValueOnce(null);
    const semTelefone = await request(app).post('/api/aquecimento/numeros').set(authHeader(jwt)).send({ inboxId: inbox.id });
    expect(semTelefone.status).toBe(400);
    expect(semTelefone.body.error.message).toBe('A Evolution não informou o telefone deste número');

    const disponiveis = await request(app).get('/api/aquecimento/inboxes-disponiveis').set(authHeader(jwt));
    expect(disponiveis.status).toBe(200);
    expect(disponiveis.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: semInstancia.id, conectada: false, status: 'sem_instancia', motivo: expect.any(String) }),
      ])
    );

    evolutionMock.getConnectedNumber.mockResolvedValueOnce('+5511977776666');
    const ok = await request(app).post('/api/aquecimento/numeros').set(authHeader(jwt)).send({ inboxId: inbox.id });
    expect(ok.status).toBe(201);
    expect(ok.body.data.numero).toMatchObject({
      inboxId: inbox.id,
      telefone: '+5511977776666',
      status: 'aguardando_parceiro',
      dia: 1,
      modo: 'rampa',
      limiteDiario: 10,
    });

    const repetida = await request(app).post('/api/aquecimento/numeros').set(authHeader(jwt)).send({ inboxId: inbox.id });
    expect(repetida.status).toBe(409);
    expect(repetida.body.error.message).toBe('Este número já está em aquecimento');

    const invalida = await request(app).post('/api/aquecimento/numeros').set(authHeader(jwt)).send({});
    expect(invalida.status).toBe(400);

    const depois = await request(app).get('/api/aquecimento/inboxes-disponiveis').set(authHeader(jwt));
    expect(depois.body.data.map((i: { id: string }) => i.id)).not.toContain(inbox.id);

    const historico = await request(app).get(`/api/aquecimento/numeros/${ok.body.data.numero.id}/historico`).set(authHeader(jwt));
    expect(historico.status).toBe(200);
    expect(historico.body.data).toHaveLength(30);
    expect(historico.body.data[29]).toMatchObject({ planned: 10, actual: 0, receives: 0, failed: 0 });
    expect(historico.body.data[0]).toEqual({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), planned: 0, actual: 0, receives: 0, failed: 0 });

    const pausar = await request(app).post(`/api/aquecimento/numeros/${ok.body.data.numero.id}/pausar`).set(authHeader(jwt));
    expect(pausar.body.data.numero).toMatchObject({ status: 'pausado', pausadoMotivo: 'Pausado manualmente' });

    const remover = await request(app).delete(`/api/aquecimento/numeros/${ok.body.data.numero.id}`).set(authHeader(jwt));
    expect(remover.status).toBe(204);
    expect(await prismaTest.warmupNumber.count()).toBe(0);
  });

  it('outra conta não enxerga nem mexe (404) e sem JWT é 401', async () => {
    const c = await montarCenario();
    const outra = await createTestAccount();
    const res = await request(app).post(`/api/aquecimento/numeros/${c.numA.id}/pausar`).set(authHeader(outra.jwt));
    expect(res.status).toBe(404);
    expect((await request(app).get('/api/aquecimento')).status).toBe(401);
  });
});
