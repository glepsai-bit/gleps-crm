/**
 * T-039 — as ferramentas de agenda como o modelo as vê.
 *
 * O que importa aqui é o CONTRATO com o modelo: os enums saem do que o agente
 * pode marcar, as recusas são frases que ele consegue repassar, e a marcação
 * bem-sucedida deixa o efeito que o fluxo lê. A aritmética de horários tem
 * teste próprio (horarios.test.ts); o serviço, também (agenda.service.test.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const agendaMock = vi.hoisted(() => ({
  catalogoDoAgente: vi.fn(),
  consultarHorarios: vi.fn(),
  reservar: vi.fn(),
  agendar: vi.fn(),
  minhaReuniao: vi.fn(),
  remarcar: vi.fn(),
  cancelar: vi.fn(),
}));
vi.mock('../agenda.service', () => ({ agendaService: agendaMock }));

import {
  lerAgendaDoAgente,
  validarAgendaDoAgente,
  definicoesDasFerramentasDeAgenda,
  executarFerramentaDeAgenda,
  ehFerramentaDeAgenda,
  type ContextoDeAgenda,
} from './ferramentas';

const AGENDA = { ativo: true as const, profissionalIds: ['u-marina', 'u-ana'], produtoIds: ['p-botox'] };

const catalogo = () => ({
  timezone: 'America/Sao_Paulo',
  configuracao: { antecedenciaMinimaMinutos: 120, janelaMaximaDias: 30, passoMinutos: 30, holdMinutos: 5, etapaAoAgendar: null },
  profissionais: [
    { userId: 'u-marina', nome: 'Dra. Marina', horarios: {}, intervaloMinutos: 0, google: { conectado: true, email: 'm@x', podeEscrever: true, precisaReconectar: false, motivo: null } },
    { userId: 'u-ana', nome: 'Ana Paula', horarios: {}, intervaloMinutos: 0, google: { conectado: false, email: null, podeEscrever: false, precisaReconectar: false, motivo: null } },
  ],
  servicos: [{ id: 'p-botox', nome: 'Botox', duracaoMinutos: 30 }],
});

const ctx = (over: Partial<ContextoDeAgenda> = {}): ContextoDeAgenda => ({
  accountId: 'acc-1',
  contactId: 'c-1',
  conversationId: 'conv-1',
  shadow: false,
  efeitos: {},
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  agendaMock.catalogoDoAgente.mockResolvedValue(catalogo());
});

describe('a config do agente', () => {
  it('lê tolerante: desligada ou torta vira null, ligada vira ids limpos', () => {
    expect(lerAgendaDoAgente(null)).toBeNull();
    expect(lerAgendaDoAgente({ ativo: false, profissionalIds: ['x'] })).toBeNull();
    expect(lerAgendaDoAgente('lixo')).toBeNull();
    expect(lerAgendaDoAgente({ ativo: true, profissionalIds: ['a', 3, ''], produtoIds: ['p'] })).toEqual({
      ativo: true,
      profissionalIds: ['a'],
      produtoIds: ['p'],
    });
  });

  it('valida estrito o que a tela grava', () => {
    expect(validarAgendaDoAgente(null)).toEqual({ agenda: null, erros: [] });
    expect(validarAgendaDoAgente({ ativo: true, profissionalIds: [], produtoIds: ['p'] }).erros[0]).toMatch(/ao menos um profissional/);
    expect(validarAgendaDoAgente({ ativo: true, profissionalIds: ['u'], produtoIds: [] }).erros[0]).toMatch(/ao menos um serviço/);
    expect(validarAgendaDoAgente({ ativo: 'sim' }).erros[0]).toMatch(/true ou false/);
    // Desligada pode ficar com listas vazias — é o estado "ainda não configurei".
    expect(validarAgendaDoAgente({ ativo: false }).agenda).toEqual({ ativo: false, profissionalIds: [], produtoIds: [] });
    expect(validarAgendaDoAgente({ ativo: true, profissionalIds: ['u', 'u'], produtoIds: ['p'] }).agenda?.profissionalIds).toEqual(['u']);
  });
});

describe('as definições', () => {
  it('seis ferramentas, com os enums saindo do catálogo', async () => {
    const { tools } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    expect(tools.map((t) => t.name)).toEqual(['consultar_horarios', 'reservar', 'agendar', 'minha_reuniao', 'remarcar', 'cancelar']);
    const consultar = tools[0].parameters as { properties: Record<string, { enum?: string[] }> };
    expect(consultar.properties.servico.enum).toEqual(['Botox']);
    expect(consultar.properties.profissional.enum).toEqual(['Dra. Marina', 'Ana Paula']);
    expect(tools[0].description).toContain('nunca invente');
    expect(tools[2].description).toContain('depois de o lead confirmar');
    expect(ehFerramentaDeAgenda('agendar')).toBe(true);
    expect(ehFerramentaDeAgenda('lembrar')).toBe(false);
  });

  it('sem profissional ou serviço ativo nas regras, nenhuma ferramenta entra', async () => {
    agendaMock.catalogoDoAgente.mockResolvedValue({ ...catalogo(), profissionais: [] });
    const { tools } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    expect(tools).toEqual([]);
  });
});

describe('consultar_horarios', () => {
  it('traduz nomes em ids, passa período e data mínima, e devolve linhas com id', async () => {
    agendaMock.consultarHorarios.mockResolvedValue({
      horarios: [
        { id: 'h1', profissionalId: 'u-marina', profissional: 'Dra. Marina', inicio: new Date(), fim: new Date(), rotulo: 'quinta-feira, 01/10 às 14:00' },
      ],
      avisos: ['a agenda de Ana Paula está indisponível agora'],
    });
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda(
      'consultar_horarios',
      { servico: 'botox', profissional: 'dra. marina', periodo: 'tarde', a_partir_de: '2026-10-05' },
      ctx(),
      AGENDA,
      cat
    );
    const chamada = agendaMock.consultarHorarios.mock.calls[0][0];
    expect(chamada).toMatchObject({ produtoId: 'p-botox', profissionalId: 'u-marina', periodo: 'tarde' });
    // 2026-10-05 00:00 em São Paulo = 03:00Z.
    expect(chamada.de.toISOString()).toBe('2026-10-05T03:00:00.000Z');
    expect(saida).toContain('id h1 | quinta-feira, 01/10 às 14:00 | com Dra. Marina');
    expect(saida).toContain('Aviso: a agenda de Ana Paula está indisponível agora.');
  });

  it('serviço ou profissional desconhecido: diz quais existem, sem consultar', async () => {
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    expect(await executarFerramentaDeAgenda('consultar_horarios', { servico: 'Peeling' }, ctx(), AGENDA, cat)).toContain('Botox');
    expect(await executarFerramentaDeAgenda('consultar_horarios', { servico: 'Botox', profissional: 'Dr. Pedro' }, ctx(), AGENDA, cat)).toContain('Dra. Marina');
    expect(agendaMock.consultarHorarios).not.toHaveBeenCalled();
  });

  it('nada livre no período pedido: manda perguntar outro período', async () => {
    agendaMock.consultarHorarios.mockResolvedValue({ horarios: [], avisos: [] });
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda('consultar_horarios', { servico: 'Botox', periodo: 'manha' }, ctx(), AGENDA, cat);
    expect(saida).toMatch(/Nenhum horário livre à manhã/);
  });
});

describe('agendar', () => {
  it('marcou: o efeito fica na bolsa e a frase manda confirmar dia e hora', async () => {
    agendaMock.agendar.mockResolvedValue({
      ok: true,
      reuniao: { eventoId: 'ev-1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox' },
      avisos: [],
    });
    const c = ctx();
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda('agendar', { id: 'h1' }, c, AGENDA, cat);
    expect(agendaMock.agendar.mock.calls[0][0]).toMatchObject({ ref: 'h1', contactId: 'c-1', conversationId: 'conv-1', shadow: false });
    expect(c.efeitos.agendou).toMatchObject({ eventoId: 'ev-1' });
    expect(saida).toContain('Marcado: quinta-feira, 01/10 às 14:00 com Dra. Marina');
  });

  it('recusa: diz em maiúsculas que NÃO marcou e não deixa efeito', async () => {
    agendaMock.agendar.mockResolvedValue({ ok: false, motivo: 'esse horário acabou de ser ocupado' });
    const c = ctx();
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda('agendar', { id: 'h1' }, c, AGENDA, cat);
    expect(saida).toMatch(/NÃO marquei: esse horário acabou de ser ocupado/);
    expect(c.efeitos.agendou).toBeUndefined();
  });

  it('em sombra o shadow vai junto e a frase avisa que é simulação', async () => {
    agendaMock.agendar.mockResolvedValue({
      ok: true,
      reuniao: { eventoId: 'sim:x', rotulo: 'r', profissional: 'p', servico: 's', simulado: true },
      avisos: [],
    });
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda('agendar', { id: 'h1' }, ctx({ shadow: true }), AGENDA, cat);
    expect(agendaMock.agendar.mock.calls[0][0].shadow).toBe(true);
    expect(saida).toContain('[simulação');
  });
});

describe('reservar, minha_reuniao, remarcar, cancelar', () => {
  it('reservar devolve o id da reserva pra passar ao agendar', async () => {
    agendaMock.reservar.mockResolvedValue({
      ok: true,
      reservaId: 'res-1',
      rotulo: 'quinta-feira, 01/10 às 14:00',
      profissional: 'Dra. Marina',
      servico: 'Botox',
      expiraEm: new Date(Date.now() + 5 * 60_000),
    });
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    const saida = await executarFerramentaDeAgenda('reservar', { horario_id: 'h1' }, ctx(), AGENDA, cat);
    expect(saida).toContain('chame agendar com o id res-1');
  });

  it('minha_reuniao confere no Google fora da sombra', async () => {
    agendaMock.minhaReuniao.mockResolvedValue(null);
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    expect(await executarFerramentaDeAgenda('minha_reuniao', {}, ctx(), AGENDA, cat)).toBe('Esta pessoa não tem reunião marcada.');
    expect(agendaMock.minhaReuniao.mock.calls[0][3]).toBe(true);
    await executarFerramentaDeAgenda('minha_reuniao', {}, ctx({ shadow: true }), AGENDA, cat);
    expect(agendaMock.minhaReuniao.mock.calls[1][3]).toBe(false);
  });

  it('remarcar e cancelar deixam os efeitos e falam o que fizeram', async () => {
    agendaMock.remarcar.mockResolvedValue({
      ok: true,
      anterior: 'quarta-feira, 30/09 às 10:00',
      reuniao: { eventoId: 'ev-1', rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina', servico: 'Botox' },
      avisos: [],
    });
    agendaMock.cancelar.mockResolvedValue({ ok: true, rotulo: 'quinta-feira, 01/10 às 14:00', profissional: 'Dra. Marina' });
    const c = ctx();
    const { catalogo: cat } = await definicoesDasFerramentasDeAgenda('acc-1', AGENDA);
    expect(await executarFerramentaDeAgenda('remarcar', { horario_id: 'h2' }, c, AGENDA, cat)).toContain('Remarcado: de quarta-feira, 30/09 às 10:00 para quinta-feira');
    expect(c.efeitos.remarcou).toBeDefined();
    expect(await executarFerramentaDeAgenda('cancelar', { motivo: 'viajou' }, c, AGENDA, cat)).toContain('Cancelado:');
    expect(agendaMock.cancelar.mock.calls[0][0]).toMatchObject({ motivo: 'viajou' });
    expect(c.efeitos.cancelou).toBeDefined();
  });
});
