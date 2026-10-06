/**
 * T-039 — agendamento pelo agente.
 *
 * O Google Calendar é a agenda: o evento vive lá e, editado lá, vence. Este
 * serviço é o que o Google não faz: sabe quando cada profissional trabalha e
 * quanto dura cada serviço, calcula os horários livres, segura o horário
 * enquanto o lead confirma, e liga a reunião à conversa — que é o que faz o
 * lembrete e o "minha reunião" existirem. Quem não conecta o Google usa a
 * agenda daqui, com as mesmas regras.
 *
 * O modelo NUNCA calcula horário. Ele pede a lista, oferece, e marca pelo id
 * que recebeu. O id é verificado de novo na hora de marcar — contra as regras
 * e contra o Google — então um id inventado ou vencido é recusado com uma
 * frase que o modelo consegue repassar ao lead.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { AppError, ValidationError } from '../utils/errors';
import { agendaGoogleService, type EstadoGoogle } from './agenda-google.service';
import {
  calcularHorarios,
  horarioValido,
  periodoDoDia,
  rotuloDoHorario,
  partesDoHorario,
  validarHorarios,
  type HorariosSemanais,
  type Ocupacao,
} from './agenda/horarios';

export interface ConfiguracaoDaAgenda {
  antecedenciaMinimaMinutos: number;
  janelaMaximaDias: number;
  passoMinutos: number;
  holdMinutos: number;
  etapaAoAgendar: string | null;
}

export const CONFIGURACAO_PADRAO: ConfiguracaoDaAgenda = {
  antecedenciaMinimaMinutos: 120,
  janelaMaximaDias: 30,
  passoMinutos: 30,
  holdMinutos: 5,
  etapaAoAgendar: null,
};

export interface ProfissionalDaAgenda {
  userId: string;
  nome: string;
  email: string;
  ativo: boolean;
  horarios: HorariosSemanais;
  intervaloMinutos: number;
  google: EstadoGoogle;
}

export interface ServicoDaAgenda {
  id: string;
  nome: string;
  duracaoMinutos: number | null;
  ativo: boolean;
  /** ETAPA B — a tela de Serviços edita preço junto da duração. 0 = sem preço. */
  valorPadrao: number;
}

/** Um horário que o agente pode oferecer. `id` é o que ele devolve ao marcar. */
export interface HorarioOferecido {
  id: string;
  profissionalId: string;
  profissional: string;
  inicio: Date;
  fim: Date;
  rotulo: string;
}

/** O que o fluxo recebe quando uma reunião é marcada — vira `{{agenda.*}}`. */
export interface ReuniaoMarcada {
  eventoId: string;
  inicio: string;
  fim: string;
  data: string;
  hora: string;
  diaDaSemana: string;
  rotulo: string;
  profissionalId: string;
  profissional: string;
  servico: string;
  googleEventId: string | null;
  /** Etapa do funil que a conta manda aplicar ao marcar. */
  etapa: string | null;
  simulado?: true;
}

type Periodo = 'manha' | 'tarde' | 'noite';

interface RegrasDoProfissional {
  userId: string;
  nome: string;
  horarios: HorariosSemanais;
  intervaloMinutos: number;
  google: EstadoGoogle;
}

interface HorarioDecodificado {
  profissionalId: string;
  produtoId: string;
  inicio: Date;
}

const MINUTO = 60_000;
const DIA = 24 * 60 * MINUTO;
/** Quantos dias à frente a primeira consulta olha. Vazio, estende até a janela máxima. */
const DIAS_DA_PRIMEIRA_CONSULTA = 7;
/** Reserva de simulador: nada é gravado, e o id diz isso. */
const PREFIXO_SIMULADO = 'sim:';

// ============================================
// Ids de horário
// ============================================
// O id carrega tudo que a marcação precisa (quem, o quê, quando) e é
// VERIFICADO na hora de marcar — não precisa de assinatura: um id forjado só
// passa se descrever um horário que as regras aceitariam de qualquer jeito.

export function codificarHorario(h: HorarioDecodificado): string {
  return Buffer.from(`${h.profissionalId}|${h.produtoId}|${h.inicio.toISOString()}`).toString('base64url');
}

export function decodificarHorario(id: string): HorarioDecodificado | null {
  try {
    const [profissionalId, produtoId, iso] = Buffer.from(String(id ?? ''), 'base64url')
      .toString('utf8')
      .split('|');
    if (!profissionalId || !produtoId || !iso) return null;
    const inicio = new Date(iso);
    if (Number.isNaN(inicio.getTime())) return null;
    return { profissionalId, produtoId, inicio };
  } catch {
    return null;
  }
}

class AgendaService {
  // ============================================
  // Regras (a tela de configuração)
  // ============================================

  private async timezoneDaConta(accountId: string): Promise<string> {
    const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { timezone: true } });
    return conta?.timezone?.trim() || 'America/Sao_Paulo';
  }

  async configuracaoDaConta(accountId: string): Promise<ConfiguracaoDaAgenda> {
    const row = await prisma.agendaConfiguracao.findUnique({ where: { accountId } });
    if (!row) return { ...CONFIGURACAO_PADRAO };
    return {
      antecedenciaMinimaMinutos: row.antecedenciaMinimaMinutos,
      janelaMaximaDias: row.janelaMaximaDias,
      passoMinutos: row.passoMinutos,
      holdMinutos: row.holdMinutos,
      etapaAoAgendar: row.etapaAoAgendar,
    };
  }

  /** Tudo que a tela de regras mostra, numa chamada. */
  async configuracao(accountId: string): Promise<{
    timezone: string;
    configuracao: ConfiguracaoDaAgenda;
    profissionais: ProfissionalDaAgenda[];
    servicos: ServicoDaAgenda[];
  }> {
    const [timezone, configuracao, usuarios, regras, produtos] = await Promise.all([
      this.timezoneDaConta(accountId),
      this.configuracaoDaConta(accountId),
      prisma.user.findMany({
        where: { accountId, status: 'active', role: { in: ['admin', 'agent'] } },
        select: { id: true, nome: true, email: true },
        orderBy: { nome: 'asc' },
      }),
      prisma.agendaProfissional.findMany({ where: { accountId } }),
      prisma.product.findMany({
        where: { accountId },
        select: { id: true, nome: true, duracaoMinutos: true, ativo: true, valorPadrao: true },
        orderBy: { nome: 'asc' },
      }),
    ]);

    const servicos: ServicoDaAgenda[] = produtos.map((p) => ({
      ...p,
      valorPadrao: Number(p.valorPadrao),
    }));

    const porUsuario = new Map(regras.map((r) => [r.userId, r]));
    const profissionais = await Promise.all(
      usuarios.map(async (u) => {
        const r = porUsuario.get(u.id);
        return {
          userId: u.id,
          nome: u.nome,
          email: u.email,
          ativo: r?.ativo ?? false,
          horarios: (r?.horarios ?? {}) as unknown as HorariosSemanais,
          intervaloMinutos: r?.intervaloMinutos ?? 0,
          google: await agendaGoogleService.estado(u.id),
        };
      })
    );

    return { timezone, configuracao, profissionais, servicos };
  }

  async salvarConfiguracao(
    accountId: string,
    input: Partial<ConfiguracaoDaAgenda>
  ): Promise<ConfiguracaoDaAgenda> {
    const atual = await this.configuracaoDaConta(accountId);
    const inteiro = (v: unknown, nome: string, min: number, max: number, padrao: number): number => {
      if (v === undefined || v === null) return padrao;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new ValidationError(`${nome} precisa ser um inteiro entre ${min} e ${max}`);
      }
      return n;
    };
    const dados = {
      antecedenciaMinimaMinutos: inteiro(input.antecedenciaMinimaMinutos, 'Antecedência mínima', 0, 7 * 24 * 60, atual.antecedenciaMinimaMinutos),
      janelaMaximaDias: inteiro(input.janelaMaximaDias, 'Janela máxima', 1, 180, atual.janelaMaximaDias),
      passoMinutos: inteiro(input.passoMinutos, 'Passo', 5, 240, atual.passoMinutos),
      holdMinutos: inteiro(input.holdMinutos, 'Reserva', 1, 60, atual.holdMinutos),
      etapaAoAgendar:
        input.etapaAoAgendar === undefined
          ? atual.etapaAoAgendar
          : typeof input.etapaAoAgendar === 'string' && input.etapaAoAgendar.trim()
            ? input.etapaAoAgendar.trim().slice(0, 120)
            : null,
    };
    await prisma.agendaConfiguracao.upsert({
      where: { accountId },
      create: { accountId, ...dados },
      update: dados,
    });
    return dados;
  }

  async salvarProfissional(
    accountId: string,
    userId: string,
    input: { ativo?: boolean; horarios?: unknown; intervaloMinutos?: number }
  ): Promise<ProfissionalDaAgenda> {
    const usuario = await prisma.user.findFirst({
      where: { id: userId, accountId, status: 'active' },
      select: { id: true, nome: true, email: true },
    });
    if (!usuario) throw new AppError('Usuário não encontrado nesta conta', 404, 'NOT_FOUND');

    const atual = await prisma.agendaProfissional.findUnique({ where: { userId } });
    const dados: { ativo?: boolean; horarios?: object; intervaloMinutos?: number } = {};

    if (input.ativo !== undefined) dados.ativo = Boolean(input.ativo);
    if (input.horarios !== undefined) {
      const { horarios, erros } = validarHorarios(input.horarios);
      if (erros.length > 0) throw new ValidationError(erros.join(' '));
      dados.horarios = horarios;
    }
    if (input.intervaloMinutos !== undefined) {
      const n = Number(input.intervaloMinutos);
      if (!Number.isInteger(n) || n < 0 || n > 240) {
        throw new ValidationError('Intervalo precisa ser um inteiro entre 0 e 240 minutos');
      }
      dados.intervaloMinutos = n;
    }

    const salvo = await prisma.agendaProfissional.upsert({
      where: { userId },
      create: {
        accountId,
        userId,
        ativo: dados.ativo ?? true,
        horarios: (dados.horarios ?? atual?.horarios ?? {}) as object,
        intervaloMinutos: dados.intervaloMinutos ?? 0,
      },
      update: dados,
    });

    return {
      userId,
      nome: usuario.nome,
      email: usuario.email,
      ativo: salvo.ativo,
      horarios: salvo.horarios as unknown as HorariosSemanais,
      intervaloMinutos: salvo.intervaloMinutos,
      google: await agendaGoogleService.estado(userId),
    };
  }

  async salvarServico(
    accountId: string,
    productId: string,
    duracaoMinutos: number | null
  ): Promise<ServicoDaAgenda> {
    const produto = await prisma.product.findFirst({ where: { id: productId, accountId }, select: { id: true } });
    if (!produto) throw new AppError('Produto não encontrado nesta conta', 404, 'NOT_FOUND');
    let duracao: number | null = null;
    if (duracaoMinutos !== null && duracaoMinutos !== undefined && duracaoMinutos !== ('' as unknown)) {
      const n = Number(duracaoMinutos);
      if (!Number.isInteger(n) || n < 5 || n > 600) {
        throw new ValidationError('Duração precisa ser um inteiro entre 5 e 600 minutos');
      }
      duracao = n;
    }
    const salvo = await prisma.product.update({
      where: { id: productId },
      data: { duracaoMinutos: duracao },
      select: { id: true, nome: true, duracaoMinutos: true, ativo: true, valorPadrao: true },
    });
    return { ...salvo, valorPadrao: Number(salvo.valorPadrao) };
  }

  /**
   * O que o AGENTE pode marcar: os profissionais e serviços que ele tem
   * permissão de usar, já filtrados pelo que está ativo nas regras. É daqui
   * que saem os enums das ferramentas — o modelo só enxerga nomes válidos.
   */
  async catalogoDoAgente(
    accountId: string,
    agenda: { profissionalIds: string[]; produtoIds: string[] }
  ): Promise<{
    timezone: string;
    configuracao: ConfiguracaoDaAgenda;
    profissionais: RegrasDoProfissional[];
    servicos: { id: string; nome: string; duracaoMinutos: number }[];
  }> {
    const [timezone, configuracao, regras, produtos] = await Promise.all([
      this.timezoneDaConta(accountId),
      this.configuracaoDaConta(accountId),
      prisma.agendaProfissional.findMany({
        where: {
          accountId,
          ativo: true,
          userId: { in: agenda.profissionalIds },
          user: { status: 'active' },
        },
        include: { user: { select: { id: true, nome: true } } },
      }),
      prisma.product.findMany({
        where: { accountId, ativo: true, id: { in: agenda.produtoIds }, duracaoMinutos: { not: null } },
        select: { id: true, nome: true, duracaoMinutos: true },
        orderBy: { nome: 'asc' },
      }),
    ]);

    const profissionais = await Promise.all(
      regras.map(async (r) => ({
        userId: r.userId,
        nome: r.user.nome,
        horarios: r.horarios as unknown as HorariosSemanais,
        intervaloMinutos: r.intervaloMinutos,
        google: await agendaGoogleService.estado(r.userId),
      }))
    );

    return {
      timezone,
      configuracao,
      profissionais,
      servicos: produtos.map((p) => ({ id: p.id, nome: p.nome, duracaoMinutos: p.duracaoMinutos as number })),
    };
  }

  // ============================================
  // Ocupações
  // ============================================

  /**
   * O que está ocupado pra um profissional numa janela: agenda local (marcado
   * ou reservado com reserva vigente) + Google, se conectado. Google que falha
   * NÃO vira "livre": devolve `indisponivel` e quem chamou decide o que dizer.
   */
  private async ocupacoesDe(
    accountId: string,
    prof: RegrasDoProfissional,
    de: Date,
    ate: Date,
    agora: Date,
    ignorarEventoId?: string
  ): Promise<{ ocupados: Ocupacao[]; indisponivel: string | null }> {
    const locais = await prisma.calendarEvent.findMany({
      where: {
        accountId,
        profissionalUserId: prof.userId,
        startTime: { lt: ate },
        endTime: { gt: de },
        ...(ignorarEventoId ? { id: { not: ignorarEventoId } } : {}),
        OR: [{ status: 'scheduled' }, { status: 'held', holdExpiresAt: { gt: agora } }],
      },
      select: { startTime: true, endTime: true },
    });
    const ocupados: Ocupacao[] = locais.map((e) => ({ inicio: e.startTime, fim: e.endTime }));

    if (!prof.google.conectado) return { ocupados, indisponivel: null };
    if (prof.google.precisaReconectar) {
      return { ocupados, indisponivel: `a agenda de ${prof.nome} precisa ser reconectada ao Google` };
    }
    try {
      const doGoogle = await agendaGoogleService.listarOcupados(accountId, prof.userId, de, ate);
      for (const o of doGoogle) ocupados.push({ inicio: o.inicio, fim: o.fim });
      return { ocupados, indisponivel: null };
    } catch (err) {
      logger.warn('[agenda] Google indisponível ao listar ocupações', {
        accountId,
        userId: prof.userId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ocupados, indisponivel: `a agenda de ${prof.nome} está indisponível agora` };
    }
  }

  // ============================================
  // Consulta
  // ============================================

  async consultarHorarios(params: {
    accountId: string;
    agenda: { profissionalIds: string[]; produtoIds: string[] };
    produtoId: string;
    /** Restringe a um profissional. Ausente = todos os que o agente pode marcar. */
    profissionalId?: string | null;
    periodo?: Periodo | null;
    de?: Date | null;
    limite?: number;
    agora?: Date;
  }): Promise<{ horarios: HorarioOferecido[]; avisos: string[] }> {
    const agora = params.agora ?? new Date();
    const catalogo = await this.catalogoDoAgente(params.accountId, params.agenda);
    const servico = catalogo.servicos.find((s) => s.id === params.produtoId);
    if (!servico) throw new ValidationError('Este serviço não pode ser agendado por este agente');

    const profissionais = params.profissionalId
      ? catalogo.profissionais.filter((p) => p.userId === params.profissionalId)
      : catalogo.profissionais;
    if (profissionais.length === 0) {
      throw new ValidationError('Nenhum profissional disponível para este agente');
    }

    const de = params.de && params.de > agora ? params.de : agora;
    const limite = Math.max(1, Math.min(params.limite ?? 6, 20));
    const avisos: string[] = [];

    const buscar = async (ate: Date): Promise<HorarioOferecido[]> => {
      const todos: HorarioOferecido[] = [];
      for (const prof of profissionais) {
        const { ocupados, indisponivel } = await this.ocupacoesDe(
          params.accountId,
          prof,
          new Date(de.getTime() - DIA),
          new Date(ate.getTime() + DIA),
          agora
        );
        if (indisponivel) {
          if (!avisos.includes(indisponivel)) avisos.push(indisponivel);
          continue;
        }
        const livres = calcularHorarios({
          agora,
          timezone: catalogo.timezone,
          horarios: prof.horarios,
          duracaoMinutos: servico.duracaoMinutos,
          intervaloMinutos: prof.intervaloMinutos,
          passoMinutos: catalogo.configuracao.passoMinutos,
          antecedenciaMinimaMinutos: catalogo.configuracao.antecedenciaMinimaMinutos,
          janelaMaximaDias: catalogo.configuracao.janelaMaximaDias,
          de,
          ate,
          ocupados,
        });
        for (const h of livres) {
          if (params.periodo && periodoDoDia(h.inicio, catalogo.timezone) !== params.periodo) continue;
          todos.push({
            id: codificarHorario({ profissionalId: prof.userId, produtoId: servico.id, inicio: h.inicio }),
            profissionalId: prof.userId,
            profissional: prof.nome,
            inicio: h.inicio,
            fim: h.fim,
            rotulo: rotuloDoHorario(h.inicio, catalogo.timezone),
          });
        }
      }
      todos.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
      return todos;
    };

    // Primeiro a semana que vem; vazia, olha até onde a janela máxima deixa.
    const janelaMaxima = new Date(agora.getTime() + catalogo.configuracao.janelaMaximaDias * DIA);
    let horarios = await buscar(new Date(Math.min(de.getTime() + DIAS_DA_PRIMEIRA_CONSULTA * DIA, janelaMaxima.getTime())));
    if (horarios.length === 0 && de.getTime() + DIAS_DA_PRIMEIRA_CONSULTA * DIA < janelaMaxima.getTime()) {
      horarios = await buscar(janelaMaxima);
    }

    return { horarios: espalharPorDia(horarios, limite, catalogo.timezone), avisos };
  }

  // ============================================
  // Validação de um horário específico
  // ============================================

  /**
   * O horário ainda vale? Regras + agenda local + Google, agora. É o que faz
   * "o lead confirmou" ser seguro: entre oferecer e confirmar passaram minutos,
   * e outra pessoa pode ter marcado — no CRM ou direto no Google.
   */
  private async validarHorario(
    accountId: string,
    agenda: { profissionalIds: string[]; produtoIds: string[] },
    h: HorarioDecodificado,
    agora: Date,
    ignorarEventoId?: string
  ): Promise<
    | { ok: true; prof: RegrasDoProfissional; servico: { id: string; nome: string; duracaoMinutos: number }; fim: Date; timezone: string; configuracao: ConfiguracaoDaAgenda }
    | { ok: false; motivo: string }
  > {
    const catalogo = await this.catalogoDoAgente(accountId, agenda);
    const servico = catalogo.servicos.find((s) => s.id === h.produtoId);
    if (!servico) return { ok: false, motivo: 'este serviço não pode mais ser agendado por aqui' };
    const prof = catalogo.profissionais.find((p) => p.userId === h.profissionalId);
    if (!prof) return { ok: false, motivo: 'este profissional não está mais disponível para agendamento' };

    const fim = new Date(h.inicio.getTime() + servico.duracaoMinutos * MINUTO);
    const { ocupados, indisponivel } = await this.ocupacoesDe(
      accountId,
      prof,
      new Date(h.inicio.getTime() - DIA),
      new Date(fim.getTime() + DIA),
      agora,
      ignorarEventoId
    );
    if (indisponivel) return { ok: false, motivo: indisponivel };

    const valido = horarioValido(
      {
        agora,
        timezone: catalogo.timezone,
        horarios: prof.horarios,
        duracaoMinutos: servico.duracaoMinutos,
        intervaloMinutos: prof.intervaloMinutos,
        passoMinutos: catalogo.configuracao.passoMinutos,
        antecedenciaMinimaMinutos: catalogo.configuracao.antecedenciaMinimaMinutos,
        janelaMaximaDias: catalogo.configuracao.janelaMaximaDias,
        ocupados,
      },
      h.inicio
    );
    if (!valido) return { ok: false, motivo: 'esse horário não está mais disponível' };

    return { ok: true, prof, servico, fim, timezone: catalogo.timezone, configuracao: catalogo.configuracao };
  }

  // ============================================
  // Reservar
  // ============================================

  async reservar(params: {
    accountId: string;
    agenda: { profissionalIds: string[]; produtoIds: string[] };
    horarioId: string;
    contactId: string | null;
    conversationId: string | null;
    shadow: boolean;
    agora?: Date;
  }): Promise<{ ok: true; reservaId: string; rotulo: string; profissional: string; servico: string; expiraEm: Date; simulado?: true } | { ok: false; motivo: string }> {
    const agora = params.agora ?? new Date();
    const h = decodificarHorario(params.horarioId);
    if (!h) return { ok: false, motivo: 'esse horário não veio de consultar_horarios' };

    const v = await this.validarHorario(params.accountId, params.agenda, h, agora);
    if (!v.ok) return v;

    const expiraEm = new Date(agora.getTime() + v.configuracao.holdMinutos * MINUTO);
    const rotulo = rotuloDoHorario(h.inicio, v.timezone);

    if (params.shadow) {
      return { ok: true, reservaId: PREFIXO_SIMULADO + params.horarioId, rotulo, profissional: v.prof.nome, servico: v.servico.nome, expiraEm, simulado: true };
    }

    const contato = await this.nomeDoContato(params.accountId, params.contactId);
    const criado = await this.gravarComTrava(v.prof.userId, async (tx) => {
      const conflito = await this.conflitoNaTransacao(tx, params.accountId, v.prof.userId, h.inicio, v.fim, agora);
      if (conflito) return null;
      return tx.calendarEvent.create({
        data: {
          accountId: params.accountId,
          title: `Reserva — ${v.servico.nome} — ${contato}`,
          startTime: h.inicio,
          endTime: v.fim,
          type: 'appointment',
          source: 'crm',
          status: 'held',
          holdExpiresAt: expiraEm,
          profissionalUserId: v.prof.userId,
          productId: v.servico.id,
          contactId: params.contactId,
          conversationId: params.conversationId,
        },
        select: { id: true },
      });
    });
    if (!criado) return { ok: false, motivo: 'esse horário acabou de ser ocupado' };

    return { ok: true, reservaId: criado.id, rotulo, profissional: v.prof.nome, servico: v.servico.nome, expiraEm };
  }

  // ============================================
  // Agendar
  // ============================================

  async agendar(params: {
    accountId: string;
    agenda: { profissionalIds: string[]; produtoIds: string[] };
    /** Id da reserva OU id do horário (o modelo pode pular a reserva). */
    ref: string;
    contactId: string | null;
    conversationId: string | null;
    shadow: boolean;
    agora?: Date;
  }): Promise<{ ok: true; reuniao: ReuniaoMarcada; avisos: string[] } | { ok: false; motivo: string }> {
    const agora = params.agora ?? new Date();
    const avisos: string[] = [];

    // ---- De onde vem o horário ----
    let h: HorarioDecodificado | null = null;
    let reservaId: string | null = null;
    const ref = String(params.ref ?? '').trim();

    if (ref.startsWith(PREFIXO_SIMULADO)) {
      h = decodificarHorario(ref.slice(PREFIXO_SIMULADO.length));
    } else if (ehUuid(ref)) {
      // Id de reserva. Reserva vencida ainda serve: o horário é reconferido
      // logo abaixo, e se continua livre não há por que recusar.
      const reserva = await prisma.calendarEvent.findFirst({
        where: { id: ref, accountId: params.accountId, status: 'held' },
        select: { id: true, startTime: true, profissionalUserId: true, productId: true },
      });
      if (reserva?.profissionalUserId && reserva.productId) {
        reservaId = reserva.id;
        h = { profissionalId: reserva.profissionalUserId, produtoId: reserva.productId, inicio: reserva.startTime };
      }
    } else {
      h = decodificarHorario(ref);
    }
    if (!h) return { ok: false, motivo: 'esse horário não veio de consultar_horarios nem de reservar' };

    // ---- Ainda vale? (regras + local + Google, agora) ----
    const v = await this.validarHorario(params.accountId, params.agenda, h, agora, reservaId ?? undefined);
    if (!v.ok) return v;

    const contato = await this.nomeDoContato(params.accountId, params.contactId);
    const telefone = await this.telefoneDoContato(params.accountId, params.contactId);
    const titulo = `${v.servico.nome} — ${contato}`;
    const descricao = [
      `Marcado pelo atendimento do CRM.`,
      telefone ? `Telefone: ${telefone}` : null,
      `Serviço: ${v.servico.nome} (${v.servico.duracaoMinutos} min)`,
    ]
      .filter(Boolean)
      .join('\n');

    const montar = (eventoId: string, googleEventId: string | null, simulado?: true): ReuniaoMarcada => ({
      eventoId,
      inicio: h!.inicio.toISOString(),
      fim: v.fim.toISOString(),
      ...partesDoHorario(h!.inicio, v.timezone),
      rotulo: rotuloDoHorario(h!.inicio, v.timezone),
      profissionalId: v.prof.userId,
      profissional: v.prof.nome,
      servico: v.servico.nome,
      googleEventId,
      etapa: v.configuracao.etapaAoAgendar,
      ...(simulado ? { simulado } : {}),
    });

    if (params.shadow) {
      return { ok: true, reuniao: montar(`sim:${codificarHorario(h)}`, null, true), avisos };
    }

    // ---- Google primeiro: se não der pra gravar lá, não grava aqui ----
    //
    // Gravar local e falhar no Google criaria uma reunião que a profissional
    // nunca vê no celular — pior que pedir pro lead tentar de novo.
    let googleEventId: string | null = null;
    const g = v.prof.google;
    if (g.conectado && !g.precisaReconectar) {
      if (!g.podeEscrever) {
        avisos.push(`o Google de ${v.prof.nome} está só leitura: a reunião ficou na agenda do CRM`);
      } else {
        try {
          const criado = await agendaGoogleService.criarEvento(params.accountId, v.prof.userId, {
            titulo,
            descricao,
            inicio: h.inicio,
            fim: v.fim,
            timezone: v.timezone,
          });
          googleEventId = criado.googleEventId;
        } catch (err) {
          logger.warn('[agenda] falha ao criar evento no Google', {
            accountId: params.accountId,
            userId: v.prof.userId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ok: false, motivo: 'não consegui gravar na agenda agora — tente de novo em instantes' };
        }
      }
    }

    // ---- Local, com trava por profissional ----
    const gravado = await this.gravarComTrava(v.prof.userId, async (tx) => {
      const conflito = await this.conflitoNaTransacao(tx, params.accountId, v.prof.userId, h!.inicio, v.fim, agora, reservaId ?? undefined);
      if (conflito) return null;
      const dados = {
        title: titulo,
        notes: descricao,
        startTime: h!.inicio,
        endTime: v.fim,
        type: 'appointment' as const,
        source: 'crm' as const,
        status: 'scheduled' as const,
        holdExpiresAt: null,
        profissionalUserId: v.prof.userId,
        productId: v.servico.id,
        contactId: params.contactId,
        conversationId: params.conversationId,
        googleEventId,
        googleCalendarId: googleEventId ? 'primary' : null,
      };
      if (reservaId) {
        return tx.calendarEvent.update({ where: { id: reservaId }, data: dados, select: { id: true } });
      }
      return tx.calendarEvent.create({ data: { accountId: params.accountId, ...dados }, select: { id: true } });
    });

    if (!gravado) {
      // Compensação: o Google já tem o evento e o CRM recusou. Apaga lá.
      if (googleEventId) {
        await agendaGoogleService.cancelarEvento(params.accountId, v.prof.userId, googleEventId).catch(() => undefined);
      }
      return { ok: false, motivo: 'esse horário acabou de ser ocupado' };
    }

    logger.info('[agenda] reunião marcada', {
      accountId: params.accountId,
      eventoId: gravado.id,
      profissional: v.prof.userId,
      google: Boolean(googleEventId),
    });
    return { ok: true, reuniao: montar(gravado.id, googleEventId), avisos };
  }

  // ============================================
  // Minha reunião / remarcar / cancelar
  // ============================================

  /**
   * A próxima reunião marcada deste contato. `null` = nenhuma.
   *
   * Com `conferir`, pergunta ao Google antes de responder: a profissional
   * pode ter apagado no celular, e "sua reunião é quinta às 14h" sobre uma
   * reunião que não existe mais é o pior erro possível aqui.
   */
  async minhaReuniao(accountId: string, contactId: string | null, agora = new Date(), conferir = false) {
    if (!contactId) return null;
    const ev = await prisma.calendarEvent.findFirst({
      where: {
        accountId,
        contactId,
        status: 'scheduled',
        profissionalUserId: { not: null },
        // Reunião que começou há menos de 2h ainda é "a reunião" (o lead pode
        // estar atrasado e perguntando).
        endTime: { gt: new Date(agora.getTime() - 2 * 60 * MINUTO) },
      },
      orderBy: { startTime: 'asc' },
      include: {
        profissional: { select: { id: true, nome: true } },
        product: { select: { id: true, nome: true } },
      },
    });
    if (!ev) return null;
    let inicio = ev.startTime;
    let fim = ev.endTime;
    if (conferir) {
      const estado = await this.estadoDaReuniao(accountId, ev.id);
      if (estado.status !== 'scheduled') return null;
      if (estado.inicio) inicio = estado.inicio;
      if (estado.fim) fim = estado.fim;
    }
    const timezone = await this.timezoneDaConta(accountId);
    return {
      eventoId: ev.id,
      inicio,
      fim,
      rotulo: rotuloDoHorario(inicio, timezone),
      profissionalId: ev.profissionalUserId as string,
      profissional: ev.profissional?.nome ?? 'profissional',
      servico: ev.product?.nome ?? ev.title,
      googleEventId: ev.googleEventId,
      timezone,
    };
  }

  async remarcar(params: {
    accountId: string;
    agenda: { profissionalIds: string[]; produtoIds: string[] };
    horarioId: string;
    contactId: string | null;
    shadow: boolean;
    agora?: Date;
  }): Promise<{ ok: true; reuniao: ReuniaoMarcada; anterior: string; avisos: string[] } | { ok: false; motivo: string }> {
    const agora = params.agora ?? new Date();
    const atual = await this.minhaReuniao(params.accountId, params.contactId, agora, !params.shadow);
    if (!atual) return { ok: false, motivo: 'esta pessoa não tem reunião marcada' };

    const h = decodificarHorario(params.horarioId);
    if (!h) return { ok: false, motivo: 'esse horário não veio de consultar_horarios' };

    const v = await this.validarHorario(params.accountId, params.agenda, h, agora, atual.eventoId);
    if (!v.ok) return v;

    const avisos: string[] = [];
    const montar = (googleEventId: string | null, simulado?: true): ReuniaoMarcada => ({
      eventoId: atual.eventoId,
      inicio: h.inicio.toISOString(),
      fim: v.fim.toISOString(),
      ...partesDoHorario(h.inicio, v.timezone),
      rotulo: rotuloDoHorario(h.inicio, v.timezone),
      profissionalId: v.prof.userId,
      profissional: v.prof.nome,
      servico: v.servico.nome,
      googleEventId,
      etapa: null,
      ...(simulado ? { simulado } : {}),
    });

    if (params.shadow) return { ok: true, reuniao: montar(atual.googleEventId, true), anterior: atual.rotulo, avisos };

    // ---- Google ----
    let googleEventId = atual.googleEventId;
    const mesmoProfissional = atual.profissionalId === v.prof.userId;
    const g = v.prof.google;
    try {
      if (mesmoProfissional && googleEventId && g.conectado && !g.precisaReconectar && g.podeEscrever) {
        await agendaGoogleService.atualizarEvento(params.accountId, v.prof.userId, googleEventId, {
          inicio: h.inicio,
          fim: v.fim,
          timezone: v.timezone,
        });
      } else if (!mesmoProfissional) {
        // Trocou de profissional: sai da agenda de um, entra na do outro.
        if (googleEventId) {
          await agendaGoogleService
            .cancelarEvento(params.accountId, atual.profissionalId, googleEventId)
            .catch(() => undefined);
          googleEventId = null;
        }
        if (g.conectado && !g.precisaReconectar && g.podeEscrever) {
          const contato = await this.nomeDoContato(params.accountId, params.contactId);
          const criado = await agendaGoogleService.criarEvento(params.accountId, v.prof.userId, {
            titulo: `${v.servico.nome} — ${contato}`,
            inicio: h.inicio,
            fim: v.fim,
            timezone: v.timezone,
          });
          googleEventId = criado.googleEventId;
        }
      }
    } catch (err) {
      logger.warn('[agenda] falha ao remarcar no Google', {
        accountId: params.accountId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, motivo: 'não consegui alterar na agenda agora — tente de novo em instantes' };
    }

    const gravado = await this.gravarComTrava(v.prof.userId, async (tx) => {
      const conflito = await this.conflitoNaTransacao(tx, params.accountId, v.prof.userId, h.inicio, v.fim, agora, atual.eventoId);
      if (conflito) return null;
      return tx.calendarEvent.update({
        where: { id: atual.eventoId },
        data: {
          startTime: h.inicio,
          endTime: v.fim,
          profissionalUserId: v.prof.userId,
          productId: v.servico.id,
          googleEventId,
          googleCalendarId: googleEventId ? 'primary' : null,
        },
        select: { id: true },
      });
    });
    if (!gravado) return { ok: false, motivo: 'esse horário acabou de ser ocupado' };

    // O lembrete que dormia pra hora antiga acorda e recalcula sozinho ao ler
    // o evento (ver flow.aguardar) — nada a fazer aqui.
    return { ok: true, reuniao: montar(googleEventId), anterior: atual.rotulo, avisos };
  }

  async cancelar(params: {
    accountId: string;
    contactId: string | null;
    motivo?: string | null;
    shadow: boolean;
    agora?: Date;
  }): Promise<{ ok: true; rotulo: string; profissional: string; simulado?: true } | { ok: false; motivo: string }> {
    const atual = await this.minhaReuniao(params.accountId, params.contactId, params.agora, !params.shadow);
    if (!atual) return { ok: false, motivo: 'esta pessoa não tem reunião marcada' };
    if (params.shadow) return { ok: true, rotulo: atual.rotulo, profissional: atual.profissional, simulado: true };

    if (atual.googleEventId) {
      try {
        await agendaGoogleService.cancelarEvento(params.accountId, atual.profissionalId, atual.googleEventId);
      } catch (err) {
        logger.warn('[agenda] falha ao cancelar no Google', {
          accountId: params.accountId,
          error: err instanceof Error ? err.message : String(err),
        });
        return { ok: false, motivo: 'não consegui cancelar na agenda agora — tente de novo em instantes' };
      }
    }

    const motivo = typeof params.motivo === 'string' ? params.motivo.trim().slice(0, 300) : '';
    await prisma.calendarEvent.update({
      where: { id: atual.eventoId },
      data: {
        status: 'cancelled',
        notes: motivo ? `Cancelado pelo lead: ${motivo}` : 'Cancelado pelo lead no atendimento',
      },
    });
    await this.encerrarLembretes(atual.eventoId, 'reuniao_cancelada');

    return { ok: true, rotulo: atual.rotulo, profissional: atual.profissional };
  }

  /**
   * O estado ATUAL de uma reunião — pro lembrete decidir se ainda faz sentido.
   *
   * Consulta o Google quando o evento vive lá: se a profissional apagou ou
   * moveu no celular, é isso que vale. O local é atualizado de tabela — é a
   * "edição no Google vence" acontecendo sem canal de push.
   */
  async estadoDaReuniao(
    accountId: string,
    eventoId: string
  ): Promise<{ status: 'scheduled' | 'cancelled' | 'inexistente'; inicio: Date | null; fim: Date | null }> {
    const ev = await prisma.calendarEvent.findFirst({
      where: { id: eventoId, accountId },
      select: { id: true, status: true, startTime: true, endTime: true, googleEventId: true, profissionalUserId: true },
    });
    if (!ev) return { status: 'inexistente', inicio: null, fim: null };
    if (ev.status !== 'scheduled') return { status: 'cancelled', inicio: ev.startTime, fim: ev.endTime };

    if (ev.googleEventId && ev.profissionalUserId) {
      try {
        const g = await agendaGoogleService.obterEvento(accountId, ev.profissionalUserId, ev.googleEventId);
        if (!g || g.status === 'cancelled') {
          await prisma.calendarEvent.update({
            where: { id: ev.id },
            data: { status: 'cancelled', notes: 'Cancelado no Google Calendar' },
          });
          await this.encerrarLembretes(ev.id, 'reuniao_cancelada');
          return { status: 'cancelled', inicio: ev.startTime, fim: ev.endTime };
        }
        if (g.inicio.getTime() !== ev.startTime.getTime() || g.fim.getTime() !== ev.endTime.getTime()) {
          await prisma.calendarEvent.update({
            where: { id: ev.id },
            data: { startTime: g.inicio, endTime: g.fim },
          });
          return { status: 'scheduled', inicio: g.inicio, fim: g.fim };
        }
      } catch (err) {
        // Google fora do ar não cancela lembrete: segue com o que o CRM sabe.
        logger.warn('[agenda] não foi possível conferir a reunião no Google', {
          accountId,
          eventoId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { status: 'scheduled', inicio: ev.startTime, fim: ev.endTime };
  }

  // ============================================
  // Internos
  // ============================================

  /** Runs dormindo à espera desta reunião (lembrete) não têm mais o que esperar. */
  private async encerrarLembretes(eventoId: string, motivo: string): Promise<void> {
    await prisma.flowRun.updateMany({
      where: { agendaEventoId: eventoId, status: 'sleeping' },
      data: { status: 'skipped', stopReason: motivo, runAfter: null, resumeNodeId: null, finishedAt: new Date() },
    });
  }

  /**
   * Trava POR PROFISSIONAL dentro da transação: dois leads confirmando o mesmo
   * horário no mesmo segundo entram em fila aqui, e o segundo encontra o
   * conflito que o primeiro acabou de criar. `pg_advisory_xact_lock` solta
   * sozinho no fim da transação — sem lock esquecido se algo lançar.
   */
  private async gravarComTrava<T>(
    profissionalUserId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'agenda:' + profissionalUserId}))`;
      return fn(tx);
    });
  }

  private async conflitoNaTransacao(
    tx: Prisma.TransactionClient,
    accountId: string,
    profissionalUserId: string,
    inicio: Date,
    fim: Date,
    agora: Date,
    ignorarEventoId?: string
  ) {
    return tx.calendarEvent.findFirst({
      where: {
        accountId,
        profissionalUserId,
        startTime: { lt: fim },
        endTime: { gt: inicio },
        ...(ignorarEventoId ? { id: { not: ignorarEventoId } } : {}),
        OR: [{ status: 'scheduled' }, { status: 'held', holdExpiresAt: { gt: agora } }],
      },
      select: { id: true },
    });
  }

  private async nomeDoContato(accountId: string, contactId: string | null): Promise<string> {
    if (!contactId) return 'lead';
    const c = await prisma.contact.findFirst({ where: { id: contactId, accountId }, select: { nome: true } });
    return c?.nome?.trim() || 'lead';
  }

  private async telefoneDoContato(accountId: string, contactId: string | null): Promise<string | null> {
    if (!contactId) return null;
    const c = await prisma.contact.findFirst({ where: { id: contactId, accountId }, select: { telefone: true } });
    return c?.telefone ?? null;
  }
}

function ehUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

/**
 * Até `limite` horários, sem entregar seis do mesmo dia: pega os primeiros de
 * cada dia em rodadas. "Quinta às 9, 9:30, 10, 10:30" não ajuda quem só pode
 * na sexta.
 */
export function espalharPorDia(horarios: HorarioOferecido[], limite: number, tz: string): HorarioOferecido[] {
  const porDia = new Map<string, HorarioOferecido[]>();
  for (const h of horarios) {
    const dia = partesDoHorario(h.inicio, tz).data;
    if (!porDia.has(dia)) porDia.set(dia, []);
    porDia.get(dia)!.push(h);
  }
  const filas = Array.from(porDia.values());
  const resultado: HorarioOferecido[] = [];
  let rodada = 0;
  while (resultado.length < limite) {
    let pegou = false;
    for (const fila of filas) {
      if (resultado.length >= limite) break;
      const h = fila[rodada];
      if (h) {
        resultado.push(h);
        pegou = true;
      }
    }
    if (!pegou) break;
    rodada++;
  }
  return resultado.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
}

export const agendaService = new AgendaService();
