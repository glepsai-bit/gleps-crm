/**
 * Dashboard 06/10 — os blocos novos de chat-metrics com o Prisma mockado.
 *
 * O que está em jogo aqui é a aritmética e o roteamento: que o período
 * anterior é a janela imediatamente antes (mesma duração), que os filtros de
 * conversa chegam onde devem (anterior/transferidas) e NÃO chegam onde não
 * devem (reuniões/origem/fechamento), que os percentuais e o ticket médio
 * devolvem null sem base, e que o "esperando há mais de 5 min" conta só o
 * balde emAberto. O banco de verdade fica com chat-metrics.integracao.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

const prismaMock = vi.hoisted(() => ({
  conversation: { findMany: vi.fn(), count: vi.fn() },
  conversationCycle: { findMany: vi.fn() },
  sLABreach: { findMany: vi.fn() },
  tagHistory: { findMany: vi.fn() },
  contact: { count: vi.fn() },
  sale: { aggregate: vi.fn(), count: vi.fn() },
  calendarEvent: { count: vi.fn() },
  $queryRaw: vi.fn(),
}));
vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { chatMetricsService } from './chat-metrics.service';

// Período de 30 dias inclusivo, como o front manda (dia inteiro nas pontas).
const FROM = new Date('2026-09-06T00:00:00.000Z');
const TO = new Date('2026-10-06T23:59:59.999Z');
const INBOX = '11111111-1111-4111-8111-111111111111';

/** Texto da query raw (tagged template) pra saber qual bloco chamou. */
function textoDa(call: unknown[]): string {
  const strings = call[0] as readonly string[];
  return strings.join('?');
}

/** Fragmento `Prisma.sql` aninhado (a classe Sql não é exportada em runtime; reconhece pela forma). */
const ehFragmentoSql = (v: unknown): v is { strings: readonly string[]; values: unknown[] } =>
  typeof v === 'object' && v !== null && 'strings' in v && 'values' in v;

/** Valores da query raw, achatando os fragmentos `Prisma.sql` aninhados. */
function valoresDe(call: unknown[]): unknown[] {
  const planos: unknown[] = [];
  const visita = (v: unknown) => {
    if (ehFragmentoSql(v)) v.values.forEach(visita);
    else planos.push(v);
  };
  call.slice(1).forEach(visita);
  return planos;
}

function chamadaRaw(marcador: string): unknown[] {
  const call = prismaMock.$queryRaw.mock.calls.find((c) => textoDa(c).includes(marcador));
  if (!call) throw new Error(`query ${marcador} não foi chamada`);
  return call;
}

/** Respostas padrão: tudo zerado, cada query raw reconhecida pelo marcador. */
function cenarioPadrao(raw: {
  anterior?: { frt: number | null; res: number | null };
  reunioes?: Array<{ date: string; total: number; pelo_agente: number }>;
  transferidas?: { total: number; com_ia: number };
  origem?: { anuncio: number; organico: number };
} = {}) {
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.conversationCycle.findMany.mockResolvedValue([]);
  prismaMock.sLABreach.findMany.mockResolvedValue([]);
  prismaMock.tagHistory.findMany.mockResolvedValue([]);
  prismaMock.contact.count.mockResolvedValue(0);
  prismaMock.sale.aggregate.mockResolvedValue({ _sum: { valor: null }, _count: { _all: 0 } });
  prismaMock.sale.count.mockResolvedValue(0);
  prismaMock.conversation.count.mockResolvedValue(0);
  prismaMock.calendarEvent.count.mockResolvedValue(0);
  prismaMock.$queryRaw.mockImplementation(async (strings: readonly string[]) => {
    const texto = strings.join('?');
    if (texto.includes('chat-metrics:anterior')) return [raw.anterior ?? { frt: null, res: null }];
    if (texto.includes('chat-metrics:reunioes')) return raw.reunioes ?? [];
    if (texto.includes('chat-metrics:transferidas')) return [raw.transferidas ?? { total: 0, com_ia: 0 }];
    if (texto.includes('chat-metrics:origem')) return [raw.origem ?? { anuncio: 0, organico: 0 }];
    return [];
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMetrics — blocos novos', () => {
  it('devolve anterior, reunioes, transferidasParaHumano, origem e o fechamento completo, sem mexer nos campos antigos', async () => {
    cenarioPadrao({
      anterior: { frt: 4.3333, res: 61.005 },
      reunioes: [
        { date: '2026-09-10', total: 2, pelo_agente: 1 },
        { date: '2026-09-12', total: 1, pelo_agente: 1 },
      ],
      transferidas: { total: 5, com_ia: 15 },
      origem: { anuncio: 7, organico: 13 },
    });
    // Período atual: 2 conversas, 1 resolvida.
    prismaMock.conversation.findMany.mockResolvedValue([
      { id: 'c1', status: 'resolved', resolvedBy: 'ai', resolvedAt: new Date('2026-09-10T10:30:00Z'), firstResponseAt: new Date('2026-09-10T10:05:00Z'), createdAt: new Date('2026-09-10T10:00:00Z'), inboxId: INBOX, teamId: null, assigneeId: null, inbox: { id: INBOX, name: 'WA' }, team: null, assignee: null },
      { id: 'c2', status: 'open', resolvedBy: null, resolvedAt: null, firstResponseAt: null, createdAt: new Date('2026-09-12T10:00:00Z'), inboxId: INBOX, teamId: null, assigneeId: null, inbox: { id: INBOX, name: 'WA' }, team: null, assignee: null },
    ]);
    // Período anterior: 10 conversas, 6 resolvidas, 3 reuniões.
    prismaMock.conversation.count.mockImplementation(async ({ where }: { where: { status?: string } }) =>
      where.status === 'resolved' ? 6 : 10
    );
    prismaMock.calendarEvent.count.mockResolvedValue(3);
    // Fechamento: 20 contatos novos, 12 atendidos, 4 com reunião, 2 vendas = R$ 700, 3 sem valor.
    prismaMock.contact.count.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (where.conversations) return 12;
      if (where.calendarEvents) return 4;
      return 20;
    });
    prismaMock.sale.aggregate.mockResolvedValue({ _sum: { valor: new Prisma.Decimal('700.00') }, _count: { _all: 2 } });
    prismaMock.sale.count.mockResolvedValue(3);
    prismaMock.tagHistory.findMany.mockImplementation(async ({ where }: { where: { tag: { papel: string } } }) =>
      where.tag.papel === 'fechamento' ? [{ contactId: 'a' }, { contactId: 'b' }] : [{ contactId: 'z' }]
    );

    const m = await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO });

    // Antigos intactos.
    expect(m).toMatchObject({
      totalConversations: 2,
      openConversations: 1,
      resolvedConversations: 1,
      byInbox: [{ inboxId: INBOX, inboxName: 'WA', total: 2, resolved: 1, open: 1, slaBreaches: 0 }],
    });
    expect(m.dailyVolume).toHaveLength(31);

    expect(m.anterior).toEqual({
      totalConversations: 10,
      resolvedConversations: 6,
      avgFirstResponseMin: 4.33,
      avgResolutionMin: 61.01,
      reunioes: 3,
    });
    expect(m.reunioes).toEqual({
      total: 3,
      peloAgente: 2,
      porDia: [
        { date: '2026-09-10', total: 2 },
        { date: '2026-09-12', total: 1 },
      ],
    });
    expect(m.transferidasParaHumano).toEqual({ total: 5, pct: 33.3 });
    expect(m.origem).toEqual({ anuncio: 7, organico: 13 });
    expect(m.fechamento).toEqual({
      conversoes: 2,
      novosContatos: 20,
      taxaConversao: 10,
      receita: 700,
      vendasComValor: 2,
      perdas: 1,
      atendidos: 12,
      comReuniao: 4,
      ticketMedio: 350,
      semValor: 3,
    });
  });

  it('o período anterior é a janela imediatamente antes, de mesma duração, e conta com o mesmo where', async () => {
    cenarioPadrao();

    await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO, inboxId: INBOX });

    // 30 dias inclusivos antes de 06/09 00:00 → 06/08 00:00 até 05/09 23:59:59.999.
    const anteriorFrom = new Date('2026-08-06T00:00:00.000Z');
    const anteriorTo = new Date('2026-09-05T23:59:59.999Z');
    const whereEsperado = {
      accountId: 'acc-1',
      OR: [
        { createdAt: { gte: anteriorFrom, lte: anteriorTo } },
        { resolvedAt: { gte: anteriorFrom, lte: anteriorTo } },
      ],
      inboxId: INBOX,
    };
    expect(prismaMock.conversation.count).toHaveBeenCalledTimes(2);
    expect(prismaMock.conversation.count).toHaveBeenCalledWith({ where: whereEsperado });
    expect(prismaMock.conversation.count).toHaveBeenCalledWith({ where: { ...whereEsperado, status: 'resolved' } });

    // Médias do anterior: mesma janela, filtro de inbox dentro do SQL.
    const anterior = chamadaRaw('chat-metrics:anterior');
    expect(valoresDe(anterior)).toEqual(expect.arrayContaining(['acc-1', anteriorFrom, anteriorTo, INBOX]));

    // Reuniões do anterior: janela anterior, SEM filtro de inbox.
    expect(prismaMock.calendarEvent.count).toHaveBeenCalledWith({
      where: {
        accountId: 'acc-1',
        createdAt: { gte: anteriorFrom, lte: anteriorTo },
        status: { in: ['scheduled', 'completed'] },
      },
    });
  });

  it('inbox/time/agente filtram transferidas, mas não reuniões, origem nem fechamento', async () => {
    cenarioPadrao();
    const TEAM = '22222222-2222-4222-8222-222222222222';
    const AGENT = '33333333-3333-4333-8333-333333333333';

    await chatMetricsService.getMetrics('acc-1', {
      fromDate: FROM,
      toDate: TO,
      inboxId: INBOX,
      teamId: TEAM,
      agentId: AGENT,
    });

    const transferidas = valoresDe(chamadaRaw('chat-metrics:transferidas'));
    expect(transferidas).toEqual(expect.arrayContaining(['acc-1', FROM, TO, INBOX, TEAM, AGENT]));

    const reunioes = valoresDe(chamadaRaw('chat-metrics:reunioes'));
    expect(reunioes).toEqual(['UTC', 'acc-1', FROM, TO]);

    const origem = valoresDe(chamadaRaw('chat-metrics:origem'));
    expect(origem).toEqual(['acc-1', FROM, TO]);

    for (const call of prismaMock.contact.count.mock.calls) {
      expect(call[0].where).not.toHaveProperty('inboxId');
      expect(call[0].where).toMatchObject({ accountId: 'acc-1', createdAt: { gte: FROM, lte: TO } });
    }
    expect(prismaMock.sale.count).toHaveBeenCalledWith({
      where: { accountId: 'acc-1', status: 'pending', origem: 'fechamento', createdAt: { gte: FROM, lte: TO } },
    });
  });

  it('reuniões por dia usam o mesmo fuso de dailyVolume quando tz vem no filtro', async () => {
    cenarioPadrao();

    await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO, tz: 'America/Sao_Paulo' });

    expect(valoresDe(chamadaRaw('chat-metrics:reunioes'))[0]).toBe('America/Sao_Paulo');
  });

  it('sem base: pct de transferidas e ticket médio voltam null; reuniões vazias voltam zeros', async () => {
    cenarioPadrao({ transferidas: { total: 0, com_ia: 0 }, reunioes: [] });

    const m = await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO });

    expect(m.transferidasParaHumano).toEqual({ total: 0, pct: null });
    expect(m.reunioes).toEqual({ total: 0, peloAgente: 0, porDia: [] });
    expect(m.origem).toEqual({ anuncio: 0, organico: 0 });
    expect(m.anterior).toEqual({
      totalConversations: 0,
      resolvedConversations: 0,
      avgFirstResponseMin: null,
      avgResolutionMin: null,
      reunioes: 0,
    });
    expect(m.fechamento).toMatchObject({ ticketMedio: null, semValor: 0, atendidos: 0, comReuniao: 0, taxaConversao: null });
  });

  it('pct de transferidas arredonda a 1 casa e aceita 100%', async () => {
    cenarioPadrao({ transferidas: { total: 2, com_ia: 3 } });
    expect((await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO })).transferidasParaHumano).toEqual({ total: 2, pct: 66.7 });

    cenarioPadrao({ transferidas: { total: 3, com_ia: 3 } });
    expect((await chatMetricsService.getMetrics('acc-1', { fromDate: FROM, toDate: TO })).transferidasParaHumano).toEqual({ total: 3, pct: 100 });
  });
});

describe('getLiveAttendance — esperandoHaMais5Min', () => {
  const AGORA = Date.now();
  const haMin = (min: number) => new Date(AGORA - min * 60_000);

  it('conta só o balde emAberto: cliente falou por último há >5 min, ou ninguém falou e a conversa é velha', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([
      // emAberto, cliente esperando há 10 min → conta
      { id: 'a', assigneeId: null, customAttributes: {}, createdAt: haMin(20) },
      // emAberto, cliente falou há 1 min → não
      { id: 'b', assigneeId: null, customAttributes: {}, createdAt: haMin(20) },
      // emAberto, sem mensagem nenhuma, aberta há 6 min → conta
      { id: 'c', assigneeId: null, customAttributes: {}, createdAt: haMin(6) },
      // emAberto, sem mensagem nenhuma, aberta há 1 min → não
      { id: 'd', assigneeId: null, customAttributes: {}, createdAt: haMin(1) },
      // emAberto, última mensagem é do sistema há 20 min → não (não é o cliente)
      { id: 'e', assigneeId: null, customAttributes: {}, createdAt: haMin(40) },
      // humano (tem assignee), cliente esperando há 30 min → não conta aqui
      { id: 'f', assigneeId: 'user-1', customAttributes: {}, createdAt: haMin(60) },
      // IA (última do bot) há 30 min → não
      { id: 'g', assigneeId: null, customAttributes: {}, createdAt: haMin(60) },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([
      { conversation_id: 'a', sender_type: 'customer', created_at: haMin(10) },
      { conversation_id: 'b', sender_type: 'customer', created_at: haMin(1) },
      { conversation_id: 'e', sender_type: 'system', created_at: haMin(20) },
      { conversation_id: 'f', sender_type: 'customer', created_at: haMin(30) },
      { conversation_id: 'g', sender_type: 'ai_bot', created_at: haMin(30) },
    ]);

    const r = await chatMetricsService.getLiveAttendance('acc-1');

    expect(r.emAberto.conversationIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(r.humano.conversationIds).toEqual(['f']);
    expect(r.ia.conversationIds).toEqual(['g']);
    expect(r.total).toBe(7);
    expect(r.esperandoHaMais5Min).toBe(2);

    // A query da última mensagem continua uma só (sem N+1), agora com created_at.
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(textoDa(prismaMock.$queryRaw.mock.calls[0])).toContain('sender_type, created_at');
  });

  it('sem conversa aberta devolve zero em tudo, inclusive esperandoHaMais5Min', async () => {
    prismaMock.conversation.findMany.mockResolvedValue([]);

    const r = await chatMetricsService.getLiveAttendance('acc-1');

    expect(r).toEqual({
      ia: { count: 0, conversationIds: [] },
      humano: { count: 0, conversationIds: [] },
      emAberto: { count: 0, conversationIds: [] },
      total: 0,
      esperandoHaMais5Min: 0,
    });
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
