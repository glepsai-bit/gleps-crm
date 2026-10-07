/**
 * Aquecimento — regras do motor com o Prisma mockado.
 *
 * Cobre: rampa, promoção no dia 31, classificação infra × número, pausa em 5
 * falhas, retomar zera, capacidadeDoNumero, aguardando_parceiro, roteiro
 * avança/encerra, cache de telefones. O banco de verdade fica no
 * aquecimento.integracao.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => ({
  account: { findUnique: vi.fn(), update: vi.fn() },
  inbox: { findMany: vi.fn(), findFirst: vi.fn() },
  warmupNumber: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
  },
  warmupMessage: { count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  warmupDailyStats: { upsert: vi.fn(), findMany: vi.fn() },
  warmupConversation: { findMany: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const evolutionMock = vi.hoisted(() => ({
  sendText: vi.fn(),
  markMessageAsRead: vi.fn(),
  sendPresence: vi.fn(),
  getStatus: vi.fn(),
  getConnectedNumber: vi.fn(),
}));
vi.mock('./evolution.service', () => ({ evolutionService: evolutionMock }));

import type { WarmupNumber } from '@prisma/client';
import {
  aquecimentoService,
  RAMPA,
  planoDoDia,
  capacidadeDe,
  classificarErro,
  variantesDoTelefone,
  dentroDaJanela,
  fracaoDaJanela,
  inicioDoDiaLocal,
  MANUTENCAO_POR_DIA,
} from './aquecimento.service';
import { ROTEIROS, sortearRoteiro } from './aquecimento/roteiros';

const CONTA = '11111111-1111-4111-8111-111111111111';
const INBOX_A = '22222222-2222-4222-8222-222222222222';
const INBOX_B = '33333333-3333-4333-8333-333333333333';

function numeroFake(sobrescreve: Partial<WarmupNumber> = {}): WarmupNumber {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    poolId: null,
    accountId: CONTA,
    inboxId: INBOX_A,
    evolutionInstance: 'inst-a',
    phoneE164: '+5511999990001',
    displayName: 'WhatsApp A',
    status: 'warming',
    currentDay: 1,
    qualityScore: 100,
    dailyEnvioPlan: [...RAMPA],
    dailyEnviadasHoje: 0,
    dailyRecebidasHoje: 0,
    falhasSeguidas: 0,
    disparosHoje: 0,
    modo: 'rampa',
    prontoEm: null,
    pausadoEm: null,
    startedAt: new Date('2026-10-07T12:00:00Z'),
    lastActivityAt: new Date('2026-10-07T12:00:00Z'),
    pausedReason: null,
    createdAt: new Date('2026-10-07T12:00:00Z'),
    updatedAt: new Date('2026-10-07T12:00:00Z'),
    ...sobrescreve,
  };
}

const A = numeroFake();
const B = numeroFake({
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  inboxId: INBOX_B,
  evolutionInstance: 'inst-b',
  phoneE164: '+5511999990002',
  displayName: 'WhatsApp B',
});

beforeEach(() => {
  vi.clearAllMocks();
  aquecimentoService.aleatorio = () => 0.5;
  aquecimentoService.esquecerCache();
  evolutionMock.sendText.mockResolvedValue({ messageId: 'evo-1', raw: {} });
  evolutionMock.markMessageAsRead.mockResolvedValue(true);
  evolutionMock.sendPresence.mockResolvedValue(true);
  prismaMock.warmupMessage.create.mockResolvedValue({});
  prismaMock.warmupMessage.count.mockResolvedValue(0);
  prismaMock.warmupNumber.update.mockResolvedValue({});
  prismaMock.warmupNumber.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.warmupConversation.update.mockResolvedValue({});
  prismaMock.warmupDailyStats.upsert.mockResolvedValue({});
  prismaMock.account.update.mockResolvedValue({});
});

// ============================================
// Rampa
// ============================================

describe('rampa única de 30 dias', () => {
  it('D1–7 = 10/12/15/20/25/30/40; D8–14 50→80; D15–21 100→180; D22–30 = 200', () => {
    expect(RAMPA).toHaveLength(30);
    expect(RAMPA.slice(0, 7)).toEqual([10, 12, 15, 20, 25, 30, 40]);
    expect(RAMPA[7]).toBe(50);
    expect(RAMPA[13]).toBe(80);
    expect(RAMPA[14]).toBe(100);
    expect(RAMPA[20]).toBe(180);
    expect(RAMPA.slice(21)).toEqual(Array(9).fill(200));
  });

  it('planoDoDia segue a rampa e cai para 20/dia na manutenção (dia 31+)', () => {
    expect(planoDoDia(1, 'rampa')).toBe(10);
    expect(planoDoDia(30, 'rampa')).toBe(200);
    expect(planoDoDia(31, 'rampa')).toBe(MANUTENCAO_POR_DIA);
    expect(planoDoDia(5, 'manutencao')).toBe(MANUTENCAO_POR_DIA);
  });
});

// ============================================
// Promoção no dia 31
// ============================================

describe('virada de dia e promoção', () => {
  const ontem = new Date('2026-10-06T15:00:00Z');
  const hoje = new Date('2026-10-07T13:00:00Z');

  it('mesmo dia local → não vira', async () => {
    const virou = await aquecimentoService.virarDiaSePreciso(
      numeroFake({ lastActivityAt: new Date('2026-10-07T11:00:00Z') }),
      hoje,
      'America/Sao_Paulo'
    );
    expect(virou).toBe(false);
    expect(prismaMock.warmupNumber.updateMany).not.toHaveBeenCalled();
  });

  it('dia 30 → 31 vira Pronto: warm, manutenção, prontoEm, contadores zerados (CAS no currentDay)', async () => {
    const n = numeroFake({ currentDay: 30, lastActivityAt: ontem, dailyEnviadasHoje: 180, disparosHoje: 7 });
    const virou = await aquecimentoService.virarDiaSePreciso(n, hoje, 'America/Sao_Paulo');
    expect(virou).toBe(true);
    const chamada = prismaMock.warmupNumber.updateMany.mock.calls[0][0];
    expect(chamada.where).toEqual({ id: n.id, currentDay: 30 });
    expect(chamada.data).toMatchObject({
      currentDay: 31,
      status: 'warm',
      modo: 'manutencao',
      prontoEm: hoje,
      dailyEnviadasHoje: 0,
      dailyRecebidasHoje: 0,
      disparosHoje: 0,
    });
    // O dia fechado vai para o histórico com o plano do dia 30.
    expect(prismaMock.warmupDailyStats.upsert.mock.calls[0][0].create).toMatchObject({
      protocolDay: 30,
      plannedSends: 200,
      actualSends: 180,
    });
  });

  it('dia 12 → 13 não promove', async () => {
    await aquecimentoService.virarDiaSePreciso(
      numeroFake({ currentDay: 12, lastActivityAt: ontem }),
      hoje,
      'America/Sao_Paulo'
    );
    const data = prismaMock.warmupNumber.updateMany.mock.calls[0][0].data;
    expect(data.currentDay).toBe(13);
    expect(data.status).toBeUndefined();
  });

  it('outro tick já virou (CAS count=0) → devolve false', async () => {
    prismaMock.warmupNumber.updateMany.mockResolvedValueOnce({ count: 0 });
    const virou = await aquecimentoService.virarDiaSePreciso(
      numeroFake({ currentDay: 3, lastActivityAt: ontem }),
      hoje,
      'America/Sao_Paulo'
    );
    expect(virou).toBe(false);
  });
});

// ============================================
// Infra × número
// ============================================

describe('classificarErro', () => {
  it.each([
    ['Falha na comunicação com Evolution API: The operation was aborted due to timeout', 'infra'],
    ['fetch failed ECONNREFUSED', 'infra'],
    ['Evolution API retornou status 500', 'infra'],
    ['Evolution API retornou status 401', 'infra'],
    ['Evolution API retornou status 403', 'infra'],
    ['Evolution API retornou status 429', 'infra'],
    ['instance not connected', 'infra'],
    ['Evolution API retornou status 400', 'numero'],
    ['Evolution API retornou status 404', 'numero'],
    ['number is not on whatsapp', 'numero'],
    ['{"exists": false, "jid": "x"}', 'numero'],
    ['invalid jid', 'numero'],
    ['contact blocked you', 'numero'],
    ['account banned', 'numero'],
    ['Telefone inválido — comprimento 3 fora do intervalo permitido (10-15)', 'numero'],
  ])('%s → %s', (mensagem, esperado) => {
    expect(classificarErro(new Error(mensagem))).toBe(esperado);
  });

  it('erro desconhecido é infra (não pune o número pelo que não entendemos)', () => {
    expect(classificarErro(new Error('algo estranho'))).toBe('infra');
    expect(classificarErro(undefined)).toBe('infra');
  });
});

describe('enviar — falhas', () => {
  const agora = new Date('2026-10-07T13:00:00Z');

  it('sucesso: grava sent, zera falhas do remetente, conta enviada e recebida', async () => {
    const r = await aquecimentoService.enviar(numeroFake({ falhasSeguidas: 2 }), B, 'oi', 'conv-1', agora);
    expect(r).toEqual({ ok: true, msgId: 'evo-1' });
    expect(evolutionMock.sendText).toHaveBeenCalledWith(CONTA, {
      number: '+5511999990002',
      text: 'oi',
      instance: 'inst-a',
    });
    expect(prismaMock.warmupMessage.create.mock.calls[0][0].data).toMatchObject({
      status: 'sent',
      evolutionMsgId: 'evo-1',
      senderId: A.id,
      receiverId: B.id,
    });
    expect(prismaMock.warmupNumber.update).toHaveBeenCalledWith({
      where: { id: A.id },
      data: { dailyEnviadasHoje: { increment: 1 }, falhasSeguidas: 0, lastActivityAt: agora },
    });
    expect(prismaMock.warmupNumber.update).toHaveBeenCalledWith({
      where: { id: B.id },
      data: { dailyRecebidasHoje: { increment: 1 }, lastActivityAt: agora },
    });
  });

  it('infra: não grava mensagem nem toca no número', async () => {
    evolutionMock.sendText.mockRejectedValueOnce(new Error('Evolution API retornou status 503'));
    const r = await aquecimentoService.enviar(numeroFake(), B, 'oi', 'conv-1', agora);
    expect(r).toMatchObject({ ok: false, tipo: 'infra' });
    expect(prismaMock.warmupMessage.create).not.toHaveBeenCalled();
    expect(prismaMock.warmupNumber.update).not.toHaveBeenCalled();
  });

  it('número: soma falha e grava failed; abaixo de 5 não pausa', async () => {
    evolutionMock.sendText.mockRejectedValueOnce(new Error('Evolution API retornou status 400'));
    const n = numeroFake({ falhasSeguidas: 2 });
    const r = await aquecimentoService.enviar(n, B, 'oi', 'conv-1', agora);
    expect(r).toMatchObject({ ok: false, tipo: 'numero' });
    expect(prismaMock.warmupMessage.create.mock.calls[0][0].data).toMatchObject({ status: 'failed' });
    const data = prismaMock.warmupNumber.update.mock.calls[0][0].data;
    expect(data.falhasSeguidas).toBe(3);
    expect(data.status).toBeUndefined();
    expect(n.status).toBe('warming');
  });

  it('5ª falha seguida pausa só este número, com motivo em português', async () => {
    evolutionMock.sendText.mockRejectedValueOnce(new Error('number is not on whatsapp'));
    const n = numeroFake({ falhasSeguidas: 4 });
    await aquecimentoService.enviar(n, B, 'oi', 'conv-1', agora);
    const data = prismaMock.warmupNumber.update.mock.calls[0][0].data;
    expect(data).toMatchObject({
      falhasSeguidas: 5,
      status: 'paused',
      pausedReason: '5 falhas seguidas no envio',
      pausadoEm: agora,
    });
    expect(prismaMock.warmupNumber.update).toHaveBeenCalledTimes(1); // o parceiro não é tocado
    expect(prismaMock.account.update).not.toHaveBeenCalled();
  });
});

// ============================================
// Retomar zera
// ============================================

describe('retomar', () => {
  it('zera falhas, limpa a pausa e mantém o dia', async () => {
    const pausado = numeroFake({ status: 'paused', falhasSeguidas: 5, currentDay: 12, pausedReason: 'x', pausadoEm: new Date() });
    prismaMock.warmupNumber.findFirst
      .mockResolvedValueOnce(pausado)
      .mockResolvedValueOnce({ ...pausado, status: 'warming', falhasSeguidas: 0, pausedReason: null, pausadoEm: null, inbox: { id: INBOX_A, name: 'WhatsApp A' } });
    prismaMock.warmupNumber.count.mockResolvedValue(2);

    const r = await aquecimentoService.retomar(CONTA, pausado.id);

    expect(prismaMock.warmupNumber.update).toHaveBeenCalledWith({
      where: { id: pausado.id },
      data: { status: 'warming', falhasSeguidas: 0, pausedReason: null, pausadoEm: null },
    });
    expect(r).toMatchObject({ status: 'aquecendo', dia: 12, falhasSeguidas: 0, saude: 'boa', pausadoMotivo: null });
  });

  it('número em manutenção volta como Pronto', async () => {
    const pausado = numeroFake({ status: 'paused', modo: 'manutencao', currentDay: 40 });
    prismaMock.warmupNumber.findFirst
      .mockResolvedValueOnce(pausado)
      .mockResolvedValueOnce({ ...pausado, status: 'warm', inbox: null });
    prismaMock.warmupNumber.count.mockResolvedValue(1);
    const r = await aquecimentoService.retomar(CONTA, pausado.id);
    expect(prismaMock.warmupNumber.update.mock.calls[0][0].data.status).toBe('warm');
    expect(r.status).toBe('pronto');
    expect(r.dia).toBe(30);
  });

  it('pausar guarda motivo e hora; já pausado não grava de novo', async () => {
    prismaMock.warmupNumber.findFirst
      .mockResolvedValueOnce(numeroFake())
      .mockResolvedValueOnce({ ...numeroFake({ status: 'paused', pausedReason: 'Pausado manualmente' }), inbox: null });
    prismaMock.warmupNumber.count.mockResolvedValue(1);
    const r = await aquecimentoService.pausar(CONTA, A.id);
    expect(prismaMock.warmupNumber.update.mock.calls[0][0].data).toMatchObject({ status: 'paused', pausedReason: 'Pausado manualmente' });
    expect(r).toMatchObject({ status: 'pausado', saude: 'pausado', pausadoMotivo: 'Pausado manualmente' });

    prismaMock.warmupNumber.update.mockClear();
    prismaMock.warmupNumber.findFirst
      .mockResolvedValueOnce(numeroFake({ status: 'paused' }))
      .mockResolvedValueOnce({ ...numeroFake({ status: 'paused' }), inbox: null });
    await aquecimentoService.pausar(CONTA, A.id);
    expect(prismaMock.warmupNumber.update).not.toHaveBeenCalled();
  });
});

// ============================================
// Capacidade
// ============================================

describe('capacidadeDoNumero', () => {
  it('inbox que nunca aqueceu → nao_aquecido com 50', async () => {
    prismaMock.warmupNumber.findFirst.mockResolvedValueOnce(null);
    await expect(aquecimentoService.capacidadeDoNumero(CONTA, INBOX_A)).resolves.toEqual({
      status: 'nao_aquecido',
      dia: 0,
      limiteDiario: 50,
      restantesHoje: 50,
    });
  });

  it('pronto → 200 menos (aquecimento + disparos)', () => {
    expect(capacidadeDe(numeroFake({ status: 'warm', currentDay: 45, modo: 'manutencao', dailyEnviadasHoje: 12, disparosHoje: 50 }))).toEqual({
      status: 'pronto',
      dia: 30,
      limiteDiario: 200,
      restantesHoje: 138,
    });
  });

  it('aquecendo → plano do dia menos enviadas e disparos, nunca negativo', () => {
    expect(capacidadeDe(numeroFake({ currentDay: 3, dailyEnviadasHoje: 10, disparosHoje: 2 }))).toEqual({
      status: 'aquecendo',
      dia: 3,
      limiteDiario: 15,
      restantesHoje: 3,
    });
    expect(capacidadeDe(numeroFake({ currentDay: 1, dailyEnviadasHoje: 10, disparosHoje: 5 })).restantesHoje).toBe(0);
  });

  it('pausado → zero', () => {
    expect(capacidadeDe(numeroFake({ status: 'paused', currentDay: 9 }))).toEqual({
      status: 'pausado',
      dia: 9,
      limiteDiario: 0,
      restantesHoje: 0,
    });
  });

  it('registrarEnvioExterno soma em disparosHoje do número da inbox', async () => {
    prismaMock.warmupNumber.updateMany.mockResolvedValueOnce({ count: 1 });
    await aquecimentoService.registrarEnvioExterno(CONTA, INBOX_A, 3);
    expect(prismaMock.warmupNumber.updateMany.mock.calls[0][0]).toMatchObject({
      where: { accountId: CONTA, inboxId: INBOX_A },
      data: { disparosHoje: { increment: 3 } },
    });
    await aquecimentoService.registrarEnvioExterno(CONTA, INBOX_A, 0);
    expect(prismaMock.warmupNumber.updateMany).toHaveBeenCalledTimes(1);
  });
});

// ============================================
// Listar / aguardando parceiro
// ============================================

describe('listar', () => {
  function contaComNumeros(numeros: Array<WarmupNumber & { inbox?: { id: string; name: string } | null }>) {
    prismaMock.account.findUnique.mockResolvedValueOnce({ timezone: 'America/Sao_Paulo', warmupInfraPausaAte: null });
    prismaMock.warmupNumber.findMany.mockResolvedValueOnce(numeros.map((n) => ({ inbox: null, ...n })));
    prismaMock.warmupMessage.count.mockResolvedValueOnce(1);
  }

  it('um só número aquecendo → aguardando_parceiro', async () => {
    contaComNumeros([{ ...A, inbox: { id: INBOX_A, name: 'WhatsApp A' } }]);
    const r = await aquecimentoService.listar(CONTA);
    expect(r.numeros[0]).toMatchObject({
      status: 'aguardando_parceiro',
      inboxNome: 'WhatsApp A',
      telefone: '+5511999990001',
      dia: 1,
      hoje: { planejadas: 10, enviadas: 0, recebidas: 0, disparos: 0 },
      saude: 'boa',
      limiteDiario: 10,
      restantesHoje: 10,
    });
    expect(r.agora).toMatchObject({
      janela: { inicio: '08:00', fim: '20:00', fuso: 'America/Sao_Paulo' },
      trocadasHoje: 0,
      falhasHoje: 1,
      infraPausaAte: null,
    });
    expect(new Date(r.agora.proximaRodadaEm).getTime()).toBeGreaterThan(Date.now());
  });

  it('dois aquecendo → aquecendo; warm → pronto; pausado → pausado; falhas → atenção', async () => {
    contaComNumeros([
      { ...A, dailyEnviadasHoje: 4, falhasSeguidas: 2 },
      { ...B, status: 'warm', modo: 'manutencao', currentDay: 33, prontoEm: new Date('2026-10-01T00:00:00Z') },
      numeroFake({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', phoneE164: '+5511999990003', status: 'paused', pausedReason: '5 falhas seguidas no envio' }),
    ]);
    const r = await aquecimentoService.listar(CONTA);
    expect(r.numeros.map((n) => n.status)).toEqual(['aquecendo', 'pronto', 'pausado']);
    expect(r.numeros[0].saude).toBe('atencao');
    expect(r.numeros[1]).toMatchObject({ dia: 30, modo: 'manutencao', limiteDiario: 200, prontoEm: '2026-10-01T00:00:00.000Z' });
    expect(r.numeros[2]).toMatchObject({ saude: 'pausado', pausadoMotivo: '5 falhas seguidas no envio', limiteDiario: 0 });
    expect(r.agora.trocadasHoje).toBe(4);
  });

  it('pausa de infra no futuro aparece; no passado vira null', async () => {
    prismaMock.account.findUnique.mockResolvedValueOnce({
      timezone: 'America/Sao_Paulo',
      warmupInfraPausaAte: new Date(Date.now() + 60_000),
    });
    prismaMock.warmupNumber.findMany.mockResolvedValueOnce([]);
    expect((await aquecimentoService.listar(CONTA)).agora.infraPausaAte).not.toBeNull();

    prismaMock.account.findUnique.mockResolvedValueOnce({
      timezone: 'America/Sao_Paulo',
      warmupInfraPausaAte: new Date(Date.now() - 60_000),
    });
    prismaMock.warmupNumber.findMany.mockResolvedValueOnce([]);
    expect((await aquecimentoService.listar(CONTA)).agora.infraPausaAte).toBeNull();
  });
});

// ============================================
// Roteiro avança / encerra
// ============================================

describe('responder', () => {
  const agora = new Date('2026-10-07T13:00:00Z');
  const roteiro = ['oi, tudo bem?', 'tudo sim e vc?', 'na correria, mas tranquilo', 'sei como é rs'];
  const conv = (passo: number, proximo: string) => ({
    id: 'conv-1',
    poolId: null,
    numberAId: A.id,
    numberBId: B.id,
    numberA: numeroFake(),
    numberB: { ...B },
    lastTurnAt: agora,
    lastSenderId: null,
    turnsCount: passo,
    isActive: true,
    createdAt: agora,
    proximaRespostaEm: agora,
    proximoRemetenteId: proximo,
    roteiro,
    passo,
    ultimoMsgId: 'evo-anterior',
  });

  it('o parceiro lê, "digita", manda a linha da vez e agenda a resposta do outro em 1–5 min', async () => {
    const r = await aquecimentoService.responder(conv(1, B.id), agora);
    expect(r).toBe('ok');
    expect(evolutionMock.markMessageAsRead).toHaveBeenCalledWith(CONTA, {
      instance: 'inst-b',
      remoteJid: '5511999990001@s.whatsapp.net',
      id: 'evo-anterior',
      fromMe: false,
    });
    const presenca = evolutionMock.sendPresence.mock.calls[0][1];
    expect(presenca).toMatchObject({ instance: 'inst-b', number: '+5511999990001', presence: 'composing' });
    expect(presenca.delayMs).toBeGreaterThanOrEqual(3000);
    expect(presenca.delayMs).toBeLessThanOrEqual(8000);
    expect(evolutionMock.sendText).toHaveBeenCalledWith(CONTA, {
      number: '+5511999990001',
      text: 'tudo sim e vc?',
      instance: 'inst-b',
    });
    const data = prismaMock.warmupConversation.update.mock.calls[0][0].data;
    expect(data.passo).toBe(2);
    expect(data.proximoRemetenteId).toBe(A.id);
    expect(data.ultimoMsgId).toBe('evo-1');
    const atraso = (data.proximaRespostaEm as Date).getTime() - agora.getTime();
    expect(atraso).toBeGreaterThanOrEqual(60_000);
    expect(atraso).toBeLessThanOrEqual(300_000);
  });

  it('última linha do roteiro encerra a conversa', async () => {
    await aquecimentoService.responder(conv(3, B.id), agora);
    expect(evolutionMock.sendText.mock.calls[0][1].text).toBe('sei como é rs');
    const data = prismaMock.warmupConversation.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ passo: 4, proximaRespostaEm: null, proximoRemetenteId: null });
  });

  it('roteiro já acabou ou parceiro pausado → encerra sem enviar', async () => {
    expect(await aquecimentoService.responder(conv(4, A.id), agora)).toBe('encerrada');
    const c = conv(1, B.id);
    c.numberA.status = 'paused';
    expect(await aquecimentoService.responder(c, agora)).toBe('encerrada');
    expect(evolutionMock.sendText).not.toHaveBeenCalled();
    expect(prismaMock.warmupConversation.update).toHaveBeenCalledTimes(2);
    expect(prismaMock.warmupConversation.update.mock.calls[0][0].data).toEqual({
      proximaRespostaEm: null,
      proximoRemetenteId: null,
    });
  });

  it('falha de infra deixa a conversa pendente para tentar depois; falha do número encerra', async () => {
    evolutionMock.sendText.mockRejectedValueOnce(new Error('Evolution API retornou status 502'));
    expect(await aquecimentoService.responder(conv(1, B.id), agora)).toBe('infra');
    expect(prismaMock.warmupConversation.update).not.toHaveBeenCalled();

    evolutionMock.sendText.mockRejectedValueOnce(new Error('Evolution API retornou status 400'));
    expect(await aquecimentoService.responder(conv(1, B.id), agora)).toBe('falha_numero');
    expect(prismaMock.warmupConversation.update.mock.calls[0][0].data).toEqual({
      proximaRespostaEm: null,
      proximoRemetenteId: null,
    });
  });

  it('abrirConversa sorteia roteiro, manda a 1ª linha e agenda o parceiro', async () => {
    prismaMock.warmupConversation.upsert.mockResolvedValueOnce({ id: 'conv-nova' });
    const r = await aquecimentoService.abrirConversa(numeroFake(), { ...B }, agora);
    expect(r).toBe('ok');
    const upsert = prismaMock.warmupConversation.upsert.mock.calls[0][0];
    expect(upsert.where).toEqual({ numberAId_numberBId: { numberAId: A.id, numberBId: B.id } });
    expect(upsert.create.roteiro).toEqual(sortearRoteiro(() => 0.5));
    expect(evolutionMock.sendText.mock.calls[0][1]).toMatchObject({ instance: 'inst-a', number: '+5511999990002', text: upsert.create.roteiro[0] });
    expect(prismaMock.warmupConversation.update.mock.calls[0][0].data).toMatchObject({ passo: 1, proximoRemetenteId: B.id });
  });
});

describe('escolherParceiro', () => {
  it('prioriza quem mais tem déficit de recebidas e ignora quem foi pausado na rodada', () => {
    const c = numeroFake({ id: 'c', phoneE164: '+5511999990003', dailyEnviadasHoje: 5, dailyRecebidasHoje: 0 });
    const d = numeroFake({ id: 'd', phoneE164: '+5511999990004', dailyEnviadasHoje: 9, dailyRecebidasHoje: 0, status: 'paused' });
    aquecimentoService.aleatorio = () => 0.9; // > 0.3 → por déficit
    expect(aquecimentoService.escolherParceiro(A, [A, B, c, d])?.id).toBe('c');
    aquecimentoService.aleatorio = () => 0.1; // 30% aleatório
    expect(['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'c']).toContain(aquecimentoService.escolherParceiro(A, [A, B, c, d])?.id);
    expect(aquecimentoService.escolherParceiro(A, [A])).toBeNull();
  });
});

// ============================================
// Roteiros
// ============================================

describe('roteiros', () => {
  it('pelo menos 25, com 2 a 6 linhas, sem placeholder nem palavra de opt-out', () => {
    expect(ROTEIROS.length).toBeGreaterThanOrEqual(25);
    for (const r of ROTEIROS) {
      expect(r.length).toBeGreaterThanOrEqual(2);
      expect(r.length).toBeLessThanOrEqual(6);
      for (const linha of r) {
        expect(linha.trim().length).toBeGreaterThan(0);
        expect(linha).not.toMatch(/\{\{|\{nome\}|https?:\/\//i);
        expect(linha).not.toMatch(/\b(sair|parar|cancelar|descadastrar)\b/i);
      }
    }
  });

  it('sortearRoteiro devolve cópia e respeita o gerador', () => {
    const a = sortearRoteiro(() => 0);
    expect(a).toEqual([...ROTEIROS[0]]);
    a.push('x');
    expect(ROTEIROS[0]).not.toContain('x');
    expect(sortearRoteiro(() => 0.999)).toEqual([...ROTEIROS[ROTEIROS.length - 1]]);
  });
});

// ============================================
// Telefones e cache
// ============================================

describe('ehNumeroDeAquecimento', () => {
  it('reconhece com e sem o nono dígito e usa cache por 60 s', async () => {
    prismaMock.warmupNumber.findMany.mockResolvedValue([{ phoneE164: '+5534999998888' }]);
    expect(await aquecimentoService.ehNumeroDeAquecimento(CONTA, '5534999998888')).toBe(true);
    expect(await aquecimentoService.ehNumeroDeAquecimento(CONTA, '553499998888')).toBe(true);
    expect(await aquecimentoService.ehNumeroDeAquecimento(CONTA, '5534999990000')).toBe(false);
    expect(await aquecimentoService.ehNumeroDeAquecimento(CONTA, '')).toBe(false);
    expect(prismaMock.warmupNumber.findMany).toHaveBeenCalledTimes(1);
    aquecimentoService.esquecerCache(CONTA);
    await aquecimentoService.ehNumeroDeAquecimento(CONTA, '5534999998888');
    expect(prismaMock.warmupNumber.findMany).toHaveBeenCalledTimes(2);
  });

  it('variantesDoTelefone', () => {
    expect(variantesDoTelefone('+5534999998888')).toEqual(['5534999998888', '553499998888']);
    expect(variantesDoTelefone('553499998888')).toEqual(['553499998888', '5534999998888']);
    expect(variantesDoTelefone('+14155550123')).toEqual(['14155550123']);
    expect(variantesDoTelefone('')).toEqual([]);
  });

  it('registrarMensagemDeAquecimento: inbound marca entregue; sem registro conta recebida; eco não faz nada', async () => {
    prismaMock.warmupMessage.updateMany.mockResolvedValueOnce({ count: 1 });
    await aquecimentoService.registrarMensagemDeAquecimento({ accountId: CONTA, inboxId: INBOX_B, evolutionMsgId: 'evo-1', fromMe: false });
    expect(prismaMock.warmupMessage.updateMany.mock.calls[0][0]).toMatchObject({
      where: { evolutionMsgId: 'evo-1' },
      data: { status: 'delivered' },
    });
    expect(prismaMock.warmupNumber.updateMany).not.toHaveBeenCalled();

    prismaMock.warmupMessage.updateMany.mockResolvedValueOnce({ count: 0 });
    prismaMock.warmupMessage.count.mockResolvedValueOnce(0);
    await aquecimentoService.registrarMensagemDeAquecimento({ accountId: CONTA, inboxId: INBOX_B, evolutionMsgId: 'manual', fromMe: false });
    expect(prismaMock.warmupNumber.updateMany.mock.calls[0][0]).toMatchObject({
      where: { accountId: CONTA, inboxId: INBOX_B },
      data: { dailyRecebidasHoje: { increment: 1 } },
    });

    prismaMock.warmupMessage.updateMany.mockClear();
    await aquecimentoService.registrarMensagemDeAquecimento({ accountId: CONTA, inboxId: INBOX_A, evolutionMsgId: 'evo-1', fromMe: true });
    expect(prismaMock.warmupMessage.updateMany).not.toHaveBeenCalled();
  });
});

// ============================================
// Fuso
// ============================================

describe('janela e fuso', () => {
  it('08–20 no fuso da conta', () => {
    expect(dentroDaJanela(new Date('2026-10-07T10:59:00Z'), 'America/Sao_Paulo')).toBe(false); // 07:59
    expect(dentroDaJanela(new Date('2026-10-07T11:00:00Z'), 'America/Sao_Paulo')).toBe(true); // 08:00
    expect(dentroDaJanela(new Date('2026-10-07T22:59:00Z'), 'America/Sao_Paulo')).toBe(true); // 19:59
    expect(dentroDaJanela(new Date('2026-10-07T23:00:00Z'), 'America/Sao_Paulo')).toBe(false); // 20:00
    expect(fracaoDaJanela(new Date('2026-10-07T17:00:00Z'), 'America/Sao_Paulo')).toBeCloseTo(0.5); // 14:00
  });

  it('inicioDoDiaLocal devolve a meia-noite local em UTC', () => {
    expect(inicioDoDiaLocal(new Date('2026-10-07T13:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-10-07T03:00:00.000Z');
    expect(inicioDoDiaLocal(new Date('2026-10-07T01:00:00Z'), 'America/Sao_Paulo').toISOString()).toBe('2026-10-06T03:00:00.000Z');
  });
});
