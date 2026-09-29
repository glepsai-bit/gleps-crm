/**
 * T-039 — o serviço de agendamento: o que ele grava, em que ordem, e o que
 * recusa. Banco e Google mockados; a aritmética de horários tem teste próprio.
 *
 * O que está em jogo é a ORDEM: Google primeiro (se não dá pra gravar lá, não
 * grava aqui), local com trava por profissional, e compensação quando o CRM
 * recusa depois que o Google já aceitou.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const prismaMock = vi.hoisted(() => {
  const calendarEvent = { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() };
  const m = {
    account: { findUnique: vi.fn() },
    agendaConfiguracao: { findUnique: vi.fn(), upsert: vi.fn() },
    agendaProfissional: { findMany: vi.fn(), findUnique: vi.fn(), upsert: vi.fn() },
    product: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn(), findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    flowRun: { updateMany: vi.fn() },
    calendarEvent,
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  // A transação recebe um "tx" que é o próprio mock: os testes olham as
  // mesmas funções, e a trava (`$executeRaw`) fica registrada.
  m.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(m));
  return m;
});
vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('../utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const googleMock = vi.hoisted(() => ({
  estado: vi.fn(),
  listarOcupados: vi.fn(),
  criarEvento: vi.fn(),
  atualizarEvento: vi.fn(),
  cancelarEvento: vi.fn(),
  obterEvento: vi.fn(),
}));
vi.mock('./agenda-google.service', () => ({ agendaGoogleService: googleMock }));

import { agendaService, codificarHorario, decodificarHorario, espalharPorDia } from './agenda.service';

const TZ = 'America/Sao_Paulo';
// Quarta 30/09/2026 10:00 em São Paulo.
const AGORA = new Date('2026-09-30T13:00:00Z');
const sp = (iso: string) => new Date(iso + '-03:00');
const AGENDA = { profissionalIds: ['u-marina', 'u-ana'], produtoIds: ['p-botox'] };

const googleOk = { conectado: true, email: 'm@x', podeEscrever: true, precisaReconectar: false, motivo: null };
const semGoogle = { conectado: false, email: null, podeEscrever: false, precisaReconectar: false, motivo: null };

function contaPadrao() {
  prismaMock.account.findUnique.mockResolvedValue({ timezone: TZ });
  prismaMock.agendaConfiguracao.findUnique.mockResolvedValue({
    antecedenciaMinimaMinutos: 120,
    janelaMaximaDias: 30,
    passoMinutos: 30,
    holdMinutos: 5,
    etapaAoAgendar: 'agendado',
  });
  prismaMock.agendaProfissional.findMany.mockResolvedValue([
    { userId: 'u-marina', horarios: { '4': [{ inicio: '09:00', fim: '12:00' }] }, intervaloMinutos: 0, user: { id: 'u-marina', nome: 'Dra. Marina' } },
    { userId: 'u-ana', horarios: { '4': [{ inicio: '09:00', fim: '10:00' }] }, intervaloMinutos: 0, user: { id: 'u-ana', nome: 'Ana Paula' } },
  ]);
  prismaMock.product.findMany.mockResolvedValue([{ id: 'p-botox', nome: 'Botox', duracaoMinutos: 30 }]);
  googleMock.estado.mockImplementation(async (userId: string) => (userId === 'u-marina' ? googleOk : semGoogle));
  googleMock.listarOcupados.mockResolvedValue([]);
  googleMock.cancelarEvento.mockResolvedValue(undefined);
  prismaMock.calendarEvent.findMany.mockResolvedValue([]);
  prismaMock.calendarEvent.findFirst.mockResolvedValue(null);
  prismaMock.contact.findFirst.mockResolvedValue({ nome: 'Carla', telefone: '+5511999999999' });
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock));
  contaPadrao();
});

describe('ids de horário', () => {
  it('codifica e decodifica sem perder nada; lixo vira null', () => {
    const h = { profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T09:00:00') };
    const id = codificarHorario(h);
    expect(decodificarHorario(id)).toEqual(h);
    expect(decodificarHorario('abc')).toBeNull();
    expect(decodificarHorario('')).toBeNull();
  });

  it('espalharPorDia não entrega seis do mesmo dia', () => {
    const mk = (iso: string) => ({ id: iso, profissionalId: 'u', profissional: 'p', inicio: sp(iso), fim: sp(iso), rotulo: iso });
    const lista = ['2026-10-01T09:00:00', '2026-10-01T09:30:00', '2026-10-01T10:00:00', '2026-10-02T09:00:00', '2026-10-02T09:30:00'].map(mk);
    expect(espalharPorDia(lista, 3, TZ).map((h) => h.id)).toEqual(['2026-10-01T09:00:00', '2026-10-01T09:30:00', '2026-10-02T09:00:00']);
  });
});

describe('consultarHorarios', () => {
  it('junta agenda local e Google, e só lista quem o agente pode marcar', async () => {
    prismaMock.calendarEvent.findMany.mockImplementation(async (q: { where: { profissionalUserId: string } }) =>
      q.where.profissionalUserId === 'u-marina'
        ? [{ startTime: sp('2026-10-01T09:00:00'), endTime: sp('2026-10-01T09:30:00') }]
        : []
    );
    googleMock.listarOcupados.mockResolvedValue([
      { googleEventId: 'g', inicio: sp('2026-10-01T09:30:00'), fim: sp('2026-10-01T10:00:00'), titulo: 'x' },
    ]);

    const { horarios, avisos } = await agendaService.consultarHorarios({
      accountId: 'acc-1',
      agenda: AGENDA,
      produtoId: 'p-botox',
      profissionalId: 'u-marina',
      agora: AGORA,
      limite: 20,
    });

    expect(avisos).toEqual([]);
    // Marina quinta 09–12, menos 09:00 (local) e 09:30 (Google).
    expect(horarios.map((h) => h.rotulo)).toEqual([
      'quinta-feira, 01/10 às 10:00',
      'quinta-feira, 01/10 às 10:30',
      'quinta-feira, 01/10 às 11:00',
      'quinta-feira, 01/10 às 11:30',
    ]);
    expect(horarios.every((h) => h.profissionalId === 'u-marina')).toBe(true);
    // Só o Google de quem tem Google.
    expect(googleMock.listarOcupados).toHaveBeenCalledTimes(1);
    expect(googleMock.listarOcupados.mock.calls[0][1]).toBe('u-marina');
    // Reserva vencida é horário livre: a consulta pede held só com hold vigente.
    const where = prismaMock.calendarEvent.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ status: 'scheduled' }, { status: 'held', holdExpiresAt: { gt: AGORA } }]);
  });

  it('Google fora do ar em um profissional: os dele somem, os outros seguem, e o aviso diz quem', async () => {
    googleMock.listarOcupados.mockRejectedValue(new Error('503'));
    const { horarios, avisos } = await agendaService.consultarHorarios({
      accountId: 'acc-1',
      agenda: AGENDA,
      produtoId: 'p-botox',
      agora: AGORA,
      limite: 20,
    });
    expect(avisos).toEqual(['a agenda de Dra. Marina está indisponível agora']);
    expect(horarios.every((h) => h.profissional === 'Ana Paula')).toBe(true);
    expect(horarios).toHaveLength(2); // Ana quinta 09:00 e 09:30
  });

  it('Google precisando reconectar: não chama, e avisa', async () => {
    googleMock.estado.mockImplementation(async (userId: string) =>
      userId === 'u-marina' ? { ...googleOk, precisaReconectar: true, motivo: 'invalid_grant' } : semGoogle
    );
    const { avisos } = await agendaService.consultarHorarios({ accountId: 'acc-1', agenda: AGENDA, produtoId: 'p-botox', agora: AGORA });
    expect(googleMock.listarOcupados).not.toHaveBeenCalled();
    expect(avisos[0]).toMatch(/reconectada ao Google/);
  });

  it('serviço que o agente não pode marcar é recusado', async () => {
    await expect(
      agendaService.consultarHorarios({ accountId: 'acc-1', agenda: AGENDA, produtoId: 'p-outro', agora: AGORA })
    ).rejects.toThrow(/não pode ser agendado/);
  });
});

describe('agendar', () => {
  const horario = () => codificarHorario({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T10:00:00') });

  it('Google primeiro, depois local com trava; devolve a reunião com a etapa das regras', async () => {
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'ev-1' });

    const r = await agendaService.agendar({
      accountId: 'acc-1',
      agenda: AGENDA,
      ref: horario(),
      contactId: 'c-1',
      conversationId: 'conv-1',
      shadow: false,
      agora: AGORA,
    });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reuniao).toMatchObject({
      eventoId: 'ev-1',
      googleEventId: 'g-novo',
      profissional: 'Dra. Marina',
      servico: 'Botox',
      hora: '10:00',
      data: '01/10',
      etapa: 'agendado',
      rotulo: 'quinta-feira, 01/10 às 10:00',
    });
    // Google antes do CRM.
    const ordemGoogle = googleMock.criarEvento.mock.invocationCallOrder[0];
    const ordemLocal = prismaMock.calendarEvent.create.mock.invocationCallOrder[0];
    expect(ordemGoogle).toBeLessThan(ordemLocal);
    expect(googleMock.criarEvento.mock.calls[0][2]).toMatchObject({ titulo: 'Botox — Carla', timezone: TZ });
    // Trava por profissional dentro da transação.
    expect(prismaMock.$executeRaw).toHaveBeenCalled();
    expect(prismaMock.calendarEvent.create.mock.calls[0][0].data).toMatchObject({
      status: 'scheduled',
      profissionalUserId: 'u-marina',
      productId: 'p-botox',
      contactId: 'c-1',
      conversationId: 'conv-1',
      googleEventId: 'g-novo',
    });
  });

  it('Google recusou: nada é gravado no CRM e a frase manda tentar de novo', async () => {
    googleMock.criarEvento.mockRejectedValue(new Error('503'));
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: horario(), contactId: 'c-1', conversationId: null, shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: false, motivo: 'não consegui gravar na agenda agora — tente de novo em instantes' });
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('o CRM achou conflito na trava depois que o Google aceitou: compensa apagando lá', async () => {
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    // A validação olha por findMany (livre); a trava, por findFirst (já tem alguém).
    prismaMock.calendarEvent.findFirst.mockResolvedValueOnce({ id: 'outro' });
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: horario(), contactId: 'c-1', conversationId: null, shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: false, motivo: 'esse horário acabou de ser ocupado' });
    expect(googleMock.cancelarEvento).toHaveBeenCalledWith('acc-1', 'u-marina', 'g-novo');
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('o Google diz que o horário foi tomado entre oferecer e confirmar: recusa sem gravar', async () => {
    googleMock.listarOcupados.mockResolvedValue([
      { googleEventId: 'g', inicio: sp('2026-10-01T10:00:00'), fim: sp('2026-10-01T10:30:00'), titulo: null },
    ]);
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: horario(), contactId: 'c-1', conversationId: null, shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: false, motivo: 'esse horário não está mais disponível' });
    expect(googleMock.criarEvento).not.toHaveBeenCalled();
  });

  it('id inventado pelo modelo é recusado', async () => {
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: 'quinta-14h', contactId: 'c-1', conversationId: null, shadow: false, agora: AGORA });
    expect(r.ok).toBe(false);
    expect(googleMock.criarEvento).not.toHaveBeenCalled();
  });

  it('com reserva: a reserva vira a reunião (update), não um evento novo', async () => {
    prismaMock.calendarEvent.findFirst
      .mockResolvedValueOnce({ id: 'res-1', startTime: sp('2026-10-01T10:00:00'), profissionalUserId: 'u-marina', productId: 'p-botox' })
      .mockResolvedValue(null);
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: 'res-1' });

    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: '11111111-1111-1111-1111-111111111111', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    expect(prismaMock.calendarEvent.update.mock.calls[0][0]).toMatchObject({ where: { id: 'res-1' }, data: { status: 'scheduled', holdExpiresAt: null } });
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('profissional sem Google: só a agenda do CRM, sem aviso', async () => {
    const h = codificarHorario({ profissionalId: 'u-ana', produtoId: 'p-botox', inicio: sp('2026-10-01T09:00:00') });
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'ev-2' });
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: h, contactId: 'c-1', conversationId: null, shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reuniao.googleEventId).toBeNull();
    expect(r.avisos).toEqual([]);
    expect(googleMock.criarEvento).not.toHaveBeenCalled();
  });

  it('em sombra nada é gravado, e a reunião volta marcada como simulada', async () => {
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: horario(), contactId: 'c-1', conversationId: null, shadow: true, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reuniao.simulado).toBe(true);
    expect(googleMock.criarEvento).not.toHaveBeenCalled();
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.$transaction).not.toHaveBeenCalled();
  });
});

describe('reservar', () => {
  it('grava a reserva com validade e devolve o id dela', async () => {
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'res-1' });
    const h = codificarHorario({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T11:00:00') });
    const r = await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reservaId).toBe('res-1');
    expect(r.expiraEm.getTime()).toBe(AGORA.getTime() + 5 * 60_000);
    expect(prismaMock.calendarEvent.create.mock.calls[0][0].data).toMatchObject({ status: 'held', holdExpiresAt: r.expiraEm });
  });
});

describe('cancelar e estadoDaReuniao', () => {
  const reuniaoLocal = () => ({
    id: 'ev-1',
    startTime: sp('2026-10-01T10:00:00'),
    endTime: sp('2026-10-01T10:30:00'),
    title: 'Botox — Carla',
    status: 'scheduled',
    profissionalUserId: 'u-marina',
    googleEventId: 'g-1',
    profissional: { id: 'u-marina', nome: 'Dra. Marina' },
    product: { id: 'p-botox', nome: 'Botox' },
  });

  it('cancelar: apaga no Google, marca local e encerra o lembrete ancorado', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue(reuniaoLocal());
    googleMock.obterEvento.mockResolvedValue({ inicio: sp('2026-10-01T10:00:00'), fim: sp('2026-10-01T10:30:00'), status: 'confirmed' });
    const r = await agendaService.cancelar({ accountId: 'acc-1', contactId: 'c-1', motivo: 'viajou', shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: true, rotulo: 'quinta-feira, 01/10 às 10:00', profissional: 'Dra. Marina' });
    expect(googleMock.cancelarEvento).toHaveBeenCalledWith('acc-1', 'u-marina', 'g-1');
    expect(prismaMock.calendarEvent.update.mock.calls[0][0]).toMatchObject({ where: { id: 'ev-1' }, data: { status: 'cancelled' } });
    expect(prismaMock.flowRun.updateMany.mock.calls[0][0].where).toEqual({ agendaEventoId: 'ev-1', status: 'sleeping' });
  });

  it('cancelar confere no Google antes: reunião já apagada lá = não tem reunião', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue(reuniaoLocal());
    googleMock.obterEvento.mockResolvedValue(null);
    const r = await agendaService.cancelar({ accountId: 'acc-1', contactId: 'c-1', shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: false, motivo: 'esta pessoa não tem reunião marcada' });
    // E o CRM ficou sabendo.
    expect(prismaMock.calendarEvent.update.mock.calls[0][0].data.status).toBe('cancelled');
    expect(googleMock.cancelarEvento).not.toHaveBeenCalled();
  });

  it('estadoDaReuniao: movida no Google → o CRM acompanha', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue(reuniaoLocal());
    googleMock.obterEvento.mockResolvedValue({ inicio: sp('2026-10-01T15:00:00'), fim: sp('2026-10-01T15:30:00'), status: 'confirmed' });
    const r = await agendaService.estadoDaReuniao('acc-1', 'ev-1');
    expect(r).toEqual({ status: 'scheduled', inicio: sp('2026-10-01T15:00:00'), fim: sp('2026-10-01T15:30:00') });
    expect(prismaMock.calendarEvent.update.mock.calls[0][0].data).toEqual({ startTime: sp('2026-10-01T15:00:00'), endTime: sp('2026-10-01T15:30:00') });
  });

  it('estadoDaReuniao: Google fora do ar não cancela nada — vale o que o CRM sabe', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue(reuniaoLocal());
    googleMock.obterEvento.mockRejectedValue(new Error('503'));
    const r = await agendaService.estadoDaReuniao('acc-1', 'ev-1');
    expect(r.status).toBe('scheduled');
    expect(prismaMock.calendarEvent.update).not.toHaveBeenCalled();
  });
});

describe('regras', () => {
  it('salvarConfiguracao valida faixas e mantém o que não veio', async () => {
    prismaMock.agendaConfiguracao.upsert.mockResolvedValue({});
    const r = await agendaService.salvarConfiguracao('acc-1', { passoMinutos: 15, etapaAoAgendar: '' });
    expect(r).toMatchObject({ passoMinutos: 15, antecedenciaMinimaMinutos: 120, etapaAoAgendar: null });
    await expect(agendaService.salvarConfiguracao('acc-1', { holdMinutos: 0 })).rejects.toThrow(/entre 1 e 60/);
  });

  it('salvarProfissional recusa usuário de outra conta e horário torto', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    await expect(agendaService.salvarProfissional('acc-1', 'u-x', { ativo: true })).rejects.toThrow(/não encontrado/);
    prismaMock.user.findFirst.mockResolvedValue({ id: 'u-marina', nome: 'Dra. Marina', email: 'm@x' });
    await expect(
      agendaService.salvarProfissional('acc-1', 'u-marina', { horarios: { '1': [{ inicio: '12:00', fim: '09:00' }] } })
    ).rejects.toThrow(/depois do início/);
  });

  it('salvarServico: duração fora da faixa é recusada; vazio desliga', async () => {
    prismaMock.product.findFirst.mockResolvedValue({ id: 'p-botox' });
    prismaMock.product.update.mockResolvedValue({ id: 'p-botox', nome: 'Botox', duracaoMinutos: null, ativo: true });
    await expect(agendaService.salvarServico('acc-1', 'p-botox', 2)).rejects.toThrow(/entre 5 e 600/);
    const r = await agendaService.salvarServico('acc-1', 'p-botox', null);
    expect(r.duracaoMinutos).toBeNull();
  });
});
