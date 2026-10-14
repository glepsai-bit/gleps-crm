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
  const calendarEvent = { findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() };
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
import { calendarioSombra } from './agenda/sombra';

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
  calendarioSombra.__limparTudo();
  prismaMock.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock));
  prismaMock.calendarEvent.updateMany.mockResolvedValue({ count: 0 });
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
      // Um dia específico: a grade inteira daquele dia (até o limite).
      dia: '2026-10-01',
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
    // A busca da reserva pendente da conversa (por conversationId) não acha
    // nada; a busca pelo id da reserva acha; a trava não acha conflito.
    prismaMock.calendarEvent.findFirst.mockImplementation(async (q: { where: { id?: string } }) =>
      q.where.id === '11111111-1111-1111-1111-111111111111'
        ? { id: 'res-1', startTime: sp('2026-10-01T10:00:00'), profissionalUserId: 'u-marina', productId: 'p-botox' }
        : null
    );
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: 'res-1' });

    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: '11111111-1111-1111-1111-111111111111', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    expect(prismaMock.calendarEvent.update.mock.calls[0][0]).toMatchObject({ where: { id: 'res-1' }, data: { status: 'scheduled', holdExpiresAt: null } });
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
    // As outras reservas da conversa são encerradas, menos a que virou reunião.
    expect(prismaMock.calendarEvent.updateMany.mock.calls[0][0].where).toMatchObject({ conversationId: 'conv-1', status: 'held', id: { not: 'res-1' } });
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

  it('a reserva anterior DESTA conversa é encerrada antes da nova (o lead mudou de ideia)', async () => {
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'res-2' });
    const h = codificarHorario({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T11:00:00') });
    const r = await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    const encerrou = prismaMock.calendarEvent.updateMany.mock.calls[0][0];
    expect(encerrou.where).toMatchObject({ accountId: 'acc-1', conversationId: 'conv-1', status: 'held' });
    expect(encerrou.data).toMatchObject({ status: 'cancelled' });
    // Encerrar vem ANTES de criar, dentro da mesma transação.
    expect(prismaMock.calendarEvent.updateMany.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.calendarEvent.create.mock.invocationCallOrder[0]);
  });
});

/*
  ETAPA G — A RESERVA PERTENCE À CONVERSA.

  O modelo reservava num turno e, no seguinte, não tinha mais a ref pra
  confirmar: 13 de 15 agendamentos do piloto morreram aí. Agora `agendar`
  sem ref usa a reserva pendente da conversa; ref que ninguém reconhece NÃO
  cai nela (o lead pode ter pedido outro horário) — vira erro curto.
*/
describe('reserva pendente da conversa', () => {
  const RES_9 = '99999999-9999-4999-8999-999999999999';
  const reservaViva = () => ({
    id: RES_9,
    title: 'Reserva — Botox — Carla',
    startTime: sp('2026-10-01T10:00:00'),
    endTime: sp('2026-10-01T10:30:00'),
    profissionalUserId: 'u-marina',
    productId: 'p-botox',
    holdExpiresAt: new Date(AGORA.getTime() + 3 * 60_000),
    profissional: { nome: 'Dra. Marina' },
    product: { nome: 'Botox' },
  });
  const porConversa = (ev: Record<string, unknown> | null) =>
    prismaMock.calendarEvent.findFirst.mockImplementation(async (q: { where: { conversationId?: string } }) => (q.where.conversationId ? ev : null));

  it('reservaPendente lê a reserva held desta conversa — inclusive vencida há pouco', async () => {
    porConversa(reservaViva());
    const r = await agendaService.reservaPendente({ accountId: 'acc-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r).toMatchObject({ reservaId: RES_9, rotulo: 'quinta-feira, 01/10 às 10:00', profissional: 'Dra. Marina', servico: 'Botox', vencida: false });
    expect(decodificarHorario(r!.horarioId)).toEqual({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T10:00:00') });
    const where = prismaMock.calendarEvent.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ accountId: 'acc-1', conversationId: 'conv-1', status: 'held' });
    // Vencida até 24h atrás ainda conta.
    expect(where.holdExpiresAt.gt.getTime()).toBe(AGORA.getTime() - 24 * 60 * 60_000);

    porConversa({ ...reservaViva(), holdExpiresAt: new Date(AGORA.getTime() - 60_000) });
    expect((await agendaService.reservaPendente({ accountId: 'acc-1', conversationId: 'conv-1', shadow: false, agora: AGORA }))?.vencida).toBe(true);
    expect(await agendaService.reservaPendente({ accountId: 'acc-1', conversationId: null, shadow: false, agora: AGORA })).toBeNull();
  });

  it('agendar SEM ref usa a reserva pendente: ela vira a reunião (update), sem evento novo', async () => {
    porConversa(reservaViva());
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: RES_9 });

    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reuniao).toMatchObject({ eventoId: RES_9, rotulo: 'quinta-feira, 01/10 às 10:00', profissional: 'Dra. Marina' });
    expect(r.avisos).toEqual([]);
    expect(prismaMock.calendarEvent.update.mock.calls[0][0]).toMatchObject({ where: { id: RES_9 }, data: { status: 'scheduled' } });
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('sem ref e sem reserva: diz o que fazer, não "horário inválido"', async () => {
    porConversa(null);
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: '', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r).toEqual({ ok: false, motivo: 'não há reserva pendente nesta conversa — consulte os horários, ofereça, e chame agendar com o id do horário escolhido' });
  });

  it('ref inventada ("terça 15h") com reserva pendente: NÃO marca a reserva antiga — erro curto com as duas saídas', async () => {
    porConversa(reservaViva());
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: RES_9 });
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: 'terça 15h', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r).toEqual({
      ok: false,
      motivo: 'Não reconheci esse horário. Se o lead confirmou a reserva de quinta-feira, 01/10 às 10:00, chame agendar sem id; se quer outro horário, consulte de novo.',
    });
    expect(prismaMock.calendarEvent.update).not.toHaveBeenCalled();
    expect(googleMock.criarEvento).not.toHaveBeenCalled();

    // Um UUID que não é de nenhuma reserva em aberto também é "desconhecido".
    const uuidDesconhecido = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: '22222222-2222-4222-8222-222222222222', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(uuidDesconhecido.ok).toBe(false);
    expect((uuidDesconhecido as { motivo: string }).motivo).toContain('Não reconheci esse horário');
    expect(prismaMock.calendarEvent.update).not.toHaveBeenCalled();

    // Sem ref (vazia) a pendente continua valendo — é o caminho do "sim".
    const vazia = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: '', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(vazia.ok).toBe(true);
    expect(prismaMock.calendarEvent.update.mock.calls[0][0].where).toEqual({ id: RES_9 });

    porConversa(null);
    const sem = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: 'terça 15h', contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(sem.ok).toBe(false);
    expect((sem as { motivo: string }).motivo).toContain('não há reserva pendente');
  });

  it('o id do HORÁRIO que já está reservado nesta conversa não conflita: a reserva vira a reunião', async () => {
    porConversa(reservaViva());
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: RES_9 });
    const h = codificarHorario({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T10:00:00') });
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: h, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(r.ok).toBe(true);
    expect(prismaMock.calendarEvent.update.mock.calls[0][0].where).toEqual({ id: RES_9 });
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
    // A validação ignorou a própria reserva ao procurar ocupação.
    const whereOcupacoes = prismaMock.calendarEvent.findMany.mock.calls[0][0].where;
    expect(whereOcupacoes.id).toEqual({ not: RES_9 });
  });

  it('reserva VENCIDA: horário ainda livre → marca com aviso; horário tomado → frase clara com a hora em que venceu', async () => {
    const vencida = { ...reservaViva(), holdExpiresAt: new Date(AGORA.getTime() - 18 * 60_000) }; // venceu 09:42
    porConversa(vencida);
    googleMock.criarEvento.mockResolvedValue({ googleEventId: 'g-novo', htmlLink: null });
    prismaMock.calendarEvent.update.mockResolvedValue({ id: RES_9 });

    const livre = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(livre.ok).toBe(true);
    if (livre.ok) expect(livre.avisos).toEqual(['a reserva tinha vencido, mas o horário continuava livre']);

    // Alguém marcou no Google nesse meio-tempo.
    googleMock.listarOcupados.mockResolvedValue([{ googleEventId: 'g', inicio: sp('2026-10-01T10:00:00'), fim: sp('2026-10-01T10:30:00'), titulo: null }]);
    const tomado = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: 'c-1', conversationId: 'conv-1', shadow: false, agora: AGORA });
    expect(tomado).toEqual({
      ok: false,
      motivo: 'a reserva de quinta-feira, 01/10 às 10:00 venceu às 09:42 e o horário já não está livre — consulte os horários de novo e ofereça outro',
    });
  });
});

/*
  ETAPA G — EM SOMBRA A RESERVA VIVE EM MEMÓRIA, POR CONVERSA.
*/
describe('sombra com chave', () => {
  const h = () => codificarHorario({ profissionalId: 'u-marina', produtoId: 'p-botox', inicio: sp('2026-10-01T10:00:00') });

  it('reservar num turno, agendar sem ref no seguinte — sem tocar no banco', async () => {
    const r1 = await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h(), contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:c1', agora: AGORA });
    expect(r1).toMatchObject({ ok: true, simulado: true, rotulo: 'quinta-feira, 01/10 às 10:00' });

    const pendente = await agendaService.reservaPendente({ accountId: 'acc-1', conversationId: null, chaveDeSombra: 'sim:c1', shadow: true, agora: AGORA });
    expect(pendente).toMatchObject({ reservaId: `sim:${h()}`, rotulo: 'quinta-feira, 01/10 às 10:00', vencida: false });

    const r2 = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:c1', agora: AGORA });
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.reuniao.simulado).toBe(true);
    expect(calendarioSombra.marcada('sim:c1')?.rotulo).toBe('quinta-feira, 01/10 às 10:00');
    expect(calendarioSombra.pendente('sim:c1')).toBeNull();

    expect(prismaMock.$transaction).not.toHaveBeenCalled();
    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
    expect(prismaMock.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(googleMock.criarEvento).not.toHaveBeenCalled();
  });

  it('duas conversas simuladas no MESMO horário não se bloqueiam', async () => {
    const a = await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h(), contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:a', agora: AGORA });
    const b = await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h(), contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:b', agora: AGORA });
    expect(a.ok && b.ok).toBe(true);
    const ma = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:a', agora: AGORA });
    const mb = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: null, conversationId: null, shadow: true, chaveDeSombra: 'sim:b', agora: AGORA });
    expect(ma.ok && mb.ok).toBe(true);
    expect(calendarioSombra.marcada('sim:a')).not.toBeNull();
    expect(calendarioSombra.marcada('sim:b')).not.toBeNull();
  });

  it('sem chave nem conversa a reserva fingida não sobrevive — agendar sem ref diz isso', async () => {
    await agendaService.reservar({ accountId: 'acc-1', agenda: AGENDA, horarioId: h(), contactId: null, conversationId: null, shadow: true, agora: AGORA });
    const r = await agendaService.agendar({ accountId: 'acc-1', agenda: AGENDA, ref: null, contactId: null, conversationId: null, shadow: true, agora: AGORA });
    expect(r.ok).toBe(false);
  });
});

/*
  ETAPA G — O QUE A CONSULTA OFERECE.

  O piloto devolvia 08:00, 08:30 e 09:00 pra quem pediu "de tarde": a lista
  eram sempre os primeiros da grade. Agora ela espalha pelo período pedido.
*/
describe('consultarHorarios — dia, período e horário desejado', () => {
  // Terça 29/09/2026 20:00 em São Paulo: amanhã (quarta) inteira está livre.
  const NOITE_ANTERIOR = new Date('2026-09-29T23:00:00Z');
  const hora = (rotulo: string) => rotulo.slice(-5);

  beforeEach(() => {
    const expediente = { inicio: '08:00', fim: '18:00' };
    prismaMock.agendaProfissional.findMany.mockResolvedValue([
      { userId: 'u-marina', horarios: { '1': [expediente], '2': [expediente], '3': [expediente], '4': [expediente], '5': [expediente] }, intervaloMinutos: 0, user: { id: 'u-marina', nome: 'Dra. Marina' } },
    ]);
  });

  const consultar = (extra: Record<string, unknown>) =>
    agendaService.consultarHorarios({ accountId: 'acc-1', agenda: AGENDA, produtoId: 'p-botox', profissionalId: 'u-marina', agora: NOITE_ANTERIOR, ...extra });

  it('"tarde" com janela 08–18 devolve só ≥ 13:00, espalhado em 3 dias e no máximo 8', async () => {
    const { horarios } = await consultar({ periodo: 'tarde' });
    expect(horarios).toHaveLength(8);
    expect(horarios.every((h) => Number(hora(h.rotulo).slice(0, 2)) >= 13)).toBe(true);
    // Não são os primeiros da tarde: o meio e o fim do dia aparecem.
    expect(horarios.filter((h) => hora(h.rotulo) === '13:00')).toHaveLength(3);
    expect(horarios.filter((h) => hora(h.rotulo) === '15:30')).toHaveLength(3);
    expect(horarios.filter((h) => hora(h.rotulo) === '17:30')).toHaveLength(2);
  });

  it('um dia específico: só aquele dia, do começo ao fim do expediente', async () => {
    const { horarios, avisos } = await consultar({ dia: '2026-10-01' });
    expect(avisos).toEqual([]);
    expect(horarios).toHaveLength(8);
    expect(horarios.every((h) => h.rotulo.startsWith('quinta-feira, 01/10'))).toBe(true);
    expect(hora(horarios[0].rotulo)).toBe('08:00');
    expect(hora(horarios[7].rotulo)).toBe('17:30');
  });

  it('horário desejado 15:00: os 3 mais próximos de cada um de 3 dias, cortado em 8', async () => {
    const { horarios } = await consultar({ horarioDesejado: '15:00' });
    expect(horarios).toHaveLength(8);
    expect(horarios.every((h) => ['14:30', '15:00', '15:30'].includes(hora(h.rotulo)))).toBe(true);
    expect(horarios.filter((h) => hora(h.rotulo) === '15:00')).toHaveLength(3);
    expect(new Set(horarios.map((h) => h.rotulo.slice(0, 20))).size).toBe(3);
  });

  it('sem pedido nenhum: 2 de manhã + 2 à tarde dos 3 próximos dias', async () => {
    const { horarios } = await consultar({});
    expect(horarios).toHaveLength(12);
    const dias = new Set(horarios.map((h) => h.rotulo.slice(0, 20)));
    expect(dias.size).toBe(3);
    expect(horarios.slice(0, 4).map((h) => hora(h.rotulo))).toEqual(['08:00', '11:30', '13:00', '17:30']);
    // Com manhã e tarde cheias, o dia é aparado espalhando: o meio-dia só entra se couber.
    expect(horarios.some((h) => hora(h.rotulo).startsWith('12:'))).toBe(false);
  });

  it('sem pedido: quem atende só à noite (19h–22h) ou só ao meio-dia recebe horários — não "nenhum horário livre"', async () => {
    for (const [faixa, confere] of [
      [{ inicio: '19:00', fim: '22:00' }, (h: number) => h >= 19],
      [{ inicio: '12:00', fim: '13:00' }, (h: number) => h === 12],
    ] as const) {
      prismaMock.agendaProfissional.findMany.mockResolvedValue([
        { userId: 'u-marina', horarios: { '1': [faixa], '2': [faixa], '3': [faixa], '4': [faixa], '5': [faixa] }, intervaloMinutos: 0, user: { id: 'u-marina', nome: 'Dra. Marina' } },
      ]);
      const { horarios } = await consultar({});
      expect(horarios.length).toBeGreaterThan(0);
      expect(horarios.every((h) => confere(Number(hora(h.rotulo).slice(0, 2))))).toBe(true);
      // 3 dias COM vaga, não 3 dias corridos.
      expect(new Set(horarios.map((h) => h.rotulo.slice(0, 20))).size).toBe(3);
    }
  });

  it('dia sem expediente: avisa e traz os dias seguintes; dia que já passou: avisa e devolve vazio', async () => {
    const domingo = await consultar({ dia: '2026-10-04' });
    expect(domingo.avisos[0]).toMatch(/nenhum horário livre em domingo, 04\/10; estes são os mais próximos/);
    expect(domingo.horarios.length).toBeGreaterThan(0);
    expect(domingo.horarios.every((h) => h.inicio > sp('2026-10-05T00:00:00'))).toBe(true);

    const passado = await consultar({ dia: '2026-09-28' });
    expect(passado).toEqual({ horarios: [], avisos: ['segunda-feira, 28/09 já passou'] });
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
