/**
 * ETAPA G — VENDA COM AGENDAMENTO EM 3 TURNOS, contra o Postgres de teste.
 *
 * consultar (tarde) → reservar → [próxima mensagem: "sim"] → agendar SEM ref
 * → CalendarEvent `scheduled`. É o cenário que o piloto perdia 13 vezes em
 * 15: a ref da reserva não sobrevivia ao turno. Só o Google é mockado
 * (profissional sem Google); banco e regras são reais.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import * as bcrypt from 'bcryptjs';

vi.mock('./agenda-google.service', () => ({
  agendaGoogleService: {
    estado: vi.fn(async () => ({ conectado: false, email: null, podeEscrever: false, precisaReconectar: false, motivo: null })),
    listarOcupados: vi.fn(async () => []),
    criarEvento: vi.fn(),
    atualizarEvento: vi.fn(),
    cancelarEvento: vi.fn(),
    obterEvento: vi.fn(),
  },
}));

import { prismaTest } from '../test/setup';
import { agendaService, decodificarHorario } from './agenda.service';
import { calendarioSombra } from './agenda/sombra';

/** Dois PrismaClient e o TRUNCATE entre casos: mesma defesa dos outros testes de integração. */
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

const EXPEDIENTE = [{ inicio: '08:00', fim: '18:00' }];

async function cenario() {
  const account = await comRetry(() => prismaTest.account.create({ data: { nome: 'Clínica', timezone: 'America/Sao_Paulo' } }));
  const prof = await comRetry(() =>
    prismaTest.user.create({
      data: {
        accountId: account.id,
        nome: 'Dr. Carlos',
        email: `carlos-${randomUUID().slice(0, 8)}@t.com`,
        passwordHash: bcrypt.hashSync('x', 4),
        role: 'admin',
        status: 'active',
        permissions: [],
      },
    })
  );
  await comRetry(() =>
    prismaTest.agendaProfissional.create({
      data: {
        accountId: account.id,
        userId: prof.id,
        ativo: true,
        // Todos os dias: o teste não pode depender de que dia é hoje.
        horarios: { '0': EXPEDIENTE, '1': EXPEDIENTE, '2': EXPEDIENTE, '3': EXPEDIENTE, '4': EXPEDIENTE, '5': EXPEDIENTE, '6': EXPEDIENTE },
      },
    })
  );
  await comRetry(() =>
    prismaTest.agendaConfiguracao.create({
      data: { accountId: account.id, antecedenciaMinimaMinutos: 120, janelaMaximaDias: 30, passoMinutos: 30, holdMinutos: 5, etapaAoAgendar: 'agendado' },
    })
  );
  const produto = await comRetry(() =>
    prismaTest.product.create({ data: { accountId: account.id, nome: 'Consulta', valorPadrao: 250, duracaoMinutos: 30, ativo: true } })
  );
  const inbox = await comRetry(() => prismaTest.inbox.create({ data: { accountId: account.id, name: 'WhatsApp', channelType: 'whatsapp', active: true } }));
  const contato = await comRetry(() => prismaTest.contact.create({ data: { accountId: account.id, nome: 'Ana', telefone: '+5511999990000' } }));
  const novaConversa = () =>
    comRetry(() => prismaTest.conversation.create({ data: { accountId: account.id, inboxId: inbox.id, contactId: contato.id, status: 'open' } }));

  const agenda = { profissionalIds: [prof.id], produtoIds: [produto.id] };
  return { account, prof, produto, contato, agenda, novaConversa };
}

const hora = (rotulo: string) => Number(rotulo.slice(-5).slice(0, 2));

beforeEach(() => calendarioSombra.__limparTudo());

describe('venda com agendamento em 3 turnos', () => {
  it('consultar (tarde) → reservar → agendar SEM ref no turno seguinte → scheduled, e a reserva virou a reunião', async () => {
    const c = await cenario();
    const conversa = await c.novaConversa();

    // Turno 1: o lead pediu "de tarde".
    const { horarios, avisos } = await agendaService.consultarHorarios({ accountId: c.account.id, agenda: c.agenda, produtoId: c.produto.id, periodo: 'tarde' });
    expect(avisos).toEqual([]);
    expect(horarios.length).toBeGreaterThan(0);
    expect(horarios.length).toBeLessThanOrEqual(8);
    expect(horarios.every((h) => hora(h.rotulo) >= 13)).toBe(true);

    // Turno 1 ainda: o lead escolheu; o agente reservou.
    const escolhido = horarios[0];
    const reserva = await agendaService.reservar({
      accountId: c.account.id,
      agenda: c.agenda,
      horarioId: escolhido.id,
      contactId: c.contato.id,
      conversationId: conversa.id,
      shadow: false,
    });
    expect(reserva.ok).toBe(true);
    if (!reserva.ok) return;

    // Turno 2: o motor lê a reserva pendente da conversa pro prompt.
    const pendente = await agendaService.reservaPendente({ accountId: c.account.id, conversationId: conversa.id, shadow: false });
    expect(pendente).toMatchObject({ reservaId: reserva.reservaId, rotulo: escolhido.rotulo, profissional: 'Dr. Carlos', servico: 'Consulta', vencida: false });

    // Turno 2: o lead disse "sim"; o agente chama agendar sem id.
    const marcado = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: null, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(marcado.ok).toBe(true);
    if (!marcado.ok) return;
    expect(marcado.reuniao).toMatchObject({ eventoId: reserva.reservaId, rotulo: escolhido.rotulo, etapa: 'agendado', googleEventId: null });

    const eventos = await prismaTest.calendarEvent.findMany({ where: { accountId: c.account.id } });
    expect(eventos.map((e) => e.status)).toEqual(['scheduled']);
    expect(eventos[0]).toMatchObject({ id: reserva.reservaId, conversationId: conversa.id, contactId: c.contato.id, holdExpiresAt: null });

    // Não há mais reserva pendente.
    expect(await agendaService.reservaPendente({ accountId: c.account.id, conversationId: conversa.id, shadow: false })).toBeNull();
  });

  it('agendar direto pelo id do horário (o lead já disse "sim" ao oferecido) — sem reservar antes', async () => {
    const c = await cenario();
    const conversa = await c.novaConversa();
    const { horarios } = await agendaService.consultarHorarios({ accountId: c.account.id, agenda: c.agenda, produtoId: c.produto.id });
    const r = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: horarios[0].id, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(r.ok).toBe(true);
    expect(await prismaTest.calendarEvent.count({ where: { accountId: c.account.id, status: 'scheduled' } })).toBe(1);
  });

  it('agendar sem ref e sem reserva: frase clara; ref inventada com reserva: erro curto (não marca o horário antigo); sem ref: marca a reserva', async () => {
    const c = await cenario();
    const conversa = await c.novaConversa();
    const nada = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: null, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(nada).toEqual({ ok: false, motivo: 'não há reserva pendente nesta conversa — consulte os horários, ofereça, e chame agendar com o id do horário escolhido' });

    const { horarios } = await agendaService.consultarHorarios({ accountId: c.account.id, agenda: c.agenda, produtoId: c.produto.id });
    await agendaService.reservar({ accountId: c.account.id, agenda: c.agenda, horarioId: horarios[0].id, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    const inventada = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: 'terça às 15h', contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(inventada).toEqual({
      ok: false,
      motivo: `Não reconheci esse horário. Se o lead confirmou a reserva de ${horarios[0].rotulo}, chame agendar sem id; se quer outro horário, consulte de novo.`,
    });
    // Nada foi marcado e a reserva continua de pé para o "sim" de verdade.
    expect(await prismaTest.calendarEvent.count({ where: { accountId: c.account.id, status: 'scheduled' } })).toBe(0);
    expect(await agendaService.reservaPendente({ accountId: c.account.id, conversationId: conversa.id, shadow: false })).not.toBeNull();

    const r = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: null, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.reuniao.rotulo).toBe(horarios[0].rotulo);
  });

  it('reserva VENCIDA: horário ainda livre marca (com aviso); horário tomado devolve "venceu às HH:MM"', async () => {
    const c = await cenario();
    const { horarios } = await agendaService.consultarHorarios({ accountId: c.account.id, agenda: c.agenda, produtoId: c.produto.id });

    // Livre: marca, avisando.
    const convA = await c.novaConversa();
    const resA = await agendaService.reservar({ accountId: c.account.id, agenda: c.agenda, horarioId: horarios[0].id, contactId: c.contato.id, conversationId: convA.id, shadow: false });
    if (!resA.ok) throw new Error(resA.motivo);
    await prismaTest.calendarEvent.update({ where: { id: resA.reservaId }, data: { holdExpiresAt: new Date(Date.now() - 10 * 60_000) } });
    const livre = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: null, contactId: c.contato.id, conversationId: convA.id, shadow: false });
    expect(livre.ok).toBe(true);
    if (livre.ok) expect(livre.avisos).toEqual(['a reserva tinha vencido, mas o horário continuava livre']);

    // Tomado: outra pessoa marcou o mesmo horário enquanto a reserva estava vencida.
    const convB = await c.novaConversa();
    const resB = await agendaService.reservar({ accountId: c.account.id, agenda: c.agenda, horarioId: horarios[1].id, contactId: c.contato.id, conversationId: convB.id, shadow: false });
    if (!resB.ok) throw new Error(resB.motivo);
    await prismaTest.calendarEvent.update({ where: { id: resB.reservaId }, data: { holdExpiresAt: new Date(Date.now() - 10 * 60_000) } });
    const h = decodificarHorario(horarios[1].id)!;
    await comRetry(() =>
      prismaTest.calendarEvent.create({
        data: {
          accountId: c.account.id,
          title: 'Outra pessoa',
          startTime: h.inicio,
          endTime: new Date(h.inicio.getTime() + 30 * 60_000),
          type: 'appointment',
          source: 'crm',
          status: 'scheduled',
          profissionalUserId: c.prof.id,
          productId: c.produto.id,
        },
      })
    );
    const tomado = await agendaService.agendar({ accountId: c.account.id, agenda: c.agenda, ref: null, contactId: c.contato.id, conversationId: convB.id, shadow: false });
    expect(tomado.ok).toBe(false);
    if (!tomado.ok) expect(tomado.motivo).toMatch(new RegExp(`^a reserva de ${horarios[1].rotulo} venceu às \\d\\d:\\d\\d e o horário já não está livre`));
  });

  it('reservar de novo na mesma conversa substitui a anterior (que fica cancelada)', async () => {
    const c = await cenario();
    const conversa = await c.novaConversa();
    const { horarios } = await agendaService.consultarHorarios({ accountId: c.account.id, agenda: c.agenda, produtoId: c.produto.id });
    const a = await agendaService.reservar({ accountId: c.account.id, agenda: c.agenda, horarioId: horarios[0].id, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    const b = await agendaService.reservar({ accountId: c.account.id, agenda: c.agenda, horarioId: horarios[1].id, contactId: c.contato.id, conversationId: conversa.id, shadow: false });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect((await prismaTest.calendarEvent.findUnique({ where: { id: a.reservaId } }))?.status).toBe('cancelled');
    expect((await agendaService.reservaPendente({ accountId: c.account.id, conversationId: conversa.id, shadow: false }))?.reservaId).toBe(b.reservaId);
  });
});
