/**
 * Aquecimento de números WhatsApp — motor simples (ETAPA W, 07/10/2026).
 *
 * Sem pool, sem estratégia, sem IA, sem mídia. Todos os números em aquecimento
 * da conta conversam entre si (precisa de 2). Rampa única de 30 dias; no dia
 * 31 o número vira "Pronto": manutenção de 20 msgs/dia e limite de 200/dia
 * para o motor de Disparos.
 *
 * O que faz a conversa parecer gente: cada conversa segue um roteiro curto
 * (aquecimento/roteiros.ts), uma linha por vez. Quem responde marca a última
 * mensagem do parceiro como lida, mostra "digitando" por 3–8 s e só então
 * responde — e a resposta é agendada para 1–5 min depois da mensagem anterior,
 * não para o próximo tick.
 *
 * Falha de infra ≠ falha do número: timeout/5xx/instância fora pausam a CONTA
 * por 15 min (account.warmupInfraPausaAte) e não tocam no número; erro do
 * número (inválido, bloqueado, banido) conta em falhasSeguidas e 5 pausam só
 * ele. Retomar zera as falhas e mantém o dia.
 *
 * Mensagens de aquecimento NUNCA entram no inbox nem acionam IA: o webhook da
 * Evolution consulta `ehNumeroDeAquecimento` antes de criar contato/conversa.
 *
 * O service antigo (whatsapp-warmup.service) fica no lugar sem ser chamado
 * pelo cron; a etapa C apaga.
 */

import type { WarmupConversation, WarmupNumber } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { evolutionService } from './evolution.service';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';
import { sortearRoteiro } from './aquecimento/roteiros';

// ============================================
// Tipos expostos (a API e o front usam estes nomes)
// ============================================

export type StatusAquecimento = 'aquecendo' | 'pronto' | 'pausado' | 'aguardando_parceiro';
export type SaudeAquecimento = 'boa' | 'atencao' | 'pausado';
export type ModoAquecimento = 'rampa' | 'manutencao';

export interface NumeroAquecimento {
  id: string;
  inboxId: string | null;
  inboxNome: string | null;
  telefone: string;
  status: StatusAquecimento;
  /** 1..30; em manutenção (dia 31+) mostra 30. */
  dia: number;
  modo: ModoAquecimento;
  hoje: { planejadas: number; enviadas: number; recebidas: number; disparos: number };
  saude: SaudeAquecimento;
  falhasSeguidas: number;
  pausadoMotivo: string | null;
  pausadoEm: string | null;
  prontoEm: string | null;
  limiteDiario: number;
  restantesHoje: number;
}

export interface SituacaoAgora {
  proximaRodadaEm: string;
  janela: { inicio: string; fim: string; fuso: string };
  trocadasHoje: number;
  falhasHoje: number;
  infraPausaAte: string | null;
}

export interface ListaAquecimento {
  numeros: NumeroAquecimento[];
  agora: SituacaoAgora;
}

export interface InboxDisponivel {
  id: string;
  nome: string;
  telefone: string | null;
  /** Estado da conexão na Evolution ('open' = pareada e funcionando). */
  status: 'open' | 'connecting' | 'close' | 'unknown' | 'sem_instancia';
  conectada: boolean;
  /** Por que não dá para aquecer agora (null quando pode). */
  motivo: string | null;
}

export interface HistoricoDia {
  date: string;
  planned: number;
  actual: number;
  receives: number;
  failed: number;
}

export interface CapacidadeDoNumero {
  status: 'pronto' | 'aquecendo' | 'pausado' | 'nao_aquecido';
  dia: number;
  limiteDiario: number;
  restantesHoje: number;
}

export interface TickResultado {
  /** true quando outra réplica já estava rodando o tick. */
  pulado: boolean;
  contas: number;
  respostas: number;
  novas: number;
  falhas: number;
  infra: number;
}

export type TipoDeFalha = 'infra' | 'numero';

// ============================================
// Constantes do protocolo
// ============================================

/** Rampa única de 30 dias (moderada). Índice = dia − 1. */
export const RAMPA: ReadonlyArray<number> = (() => {
  const plano = [10, 12, 15, 20, 25, 30, 40];
  for (let i = 0; i < 7; i++) plano.push(Math.round(50 + ((80 - 50) * i) / 6)); // D8–14
  for (let i = 0; i < 7; i++) plano.push(Math.round(100 + ((180 - 100) * i) / 6)); // D15–21
  for (let i = 0; i < 9; i++) plano.push(200); // D22–30
  return plano;
})();

export const DIAS_DE_RAMPA = 30;
export const MANUTENCAO_POR_DIA = 20;
export const LIMITE_DIARIO_PRONTO = 200;
export const LIMITE_DIARIO_NAO_AQUECIDO = 50;
export const FALHAS_PARA_PAUSAR = 5;
export const INFRA_PAUSA_MS = 15 * 60 * 1000;

const JANELA_INICIO = 8;
const JANELA_FIM = 20;
const JITTER_PULA = 0.4;
const RESPOSTA_MIN_MS = 60 * 1000;
const RESPOSTA_MAX_MS = 5 * 60 * 1000;
const DIGITANDO_MIN_MS = 3000;
const DIGITANDO_MAX_MS = 8000;
const RESPOSTAS_POR_TICK = 20;
const CACHE_NUMEROS_TTL_MS = 60 * 1000;
const FUSO_PADRAO = 'America/Sao_Paulo';
const ATIVOS = ['warming', 'warm'] as const;

// ============================================
// Fuso horário
// ============================================

function partesLocais(data: Date, fuso: string) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p: Record<string, string> = {};
  for (const parte of fmt.formatToParts(data)) p[parte.type] = parte.value;
  // Algumas runtimes devolvem '24' à meia-noite.
  const hora = p.hour === '24' ? 0 : parseInt(p.hour, 10);
  return { data: `${p.year}-${p.month}-${p.day}`, hora, minuto: parseInt(p.minute, 10) };
}

export function dataLocal(data: Date, fuso: string): string {
  return partesLocais(data, fuso).data;
}

export function dentroDaJanela(data: Date, fuso: string): boolean {
  const { hora } = partesLocais(data, fuso);
  return hora >= JANELA_INICIO && hora < JANELA_FIM;
}

/** Fração da janela 08–20 já decorrida (0..1). */
export function fracaoDaJanela(data: Date, fuso: string): number {
  const { hora, minuto } = partesLocais(data, fuso);
  const decorrido = (hora - JANELA_INICIO) * 60 + minuto;
  const total = (JANELA_FIM - JANELA_INICIO) * 60;
  return Math.min(Math.max(decorrido / total, 0), 1);
}

/** Instante (UTC) em que começou o dia local de `data` no fuso. */
export function inicioDoDiaLocal(data: Date, fuso: string): Date {
  const { data: ymd, hora, minuto } = partesLocais(data, fuso);
  const [a, m, d] = ymd.split('-').map((x) => parseInt(x, 10));
  // Relógio local lido como se fosse UTC, menos o instante real = offset do fuso.
  const localComoUtc = Date.UTC(a, m - 1, d, hora, minuto, data.getUTCSeconds());
  const offsetMs = localComoUtc - data.getTime();
  return new Date(Date.UTC(a, m - 1, d) - offsetMs);
}

// ============================================
// Regras puras (testáveis sem banco)
// ============================================

/** Quantas mensagens o número deve trocar no dia. */
export function planoDoDia(dia: number, modo: string): number {
  if (modo === 'manutencao' || dia > DIAS_DE_RAMPA) return MANUTENCAO_POR_DIA;
  return RAMPA[Math.max(dia, 1) - 1] ?? 0;
}

type NumeroParaCapacidade = Pick<
  WarmupNumber,
  'status' | 'currentDay' | 'modo' | 'dailyEnviadasHoje' | 'disparosHoje'
>;

/**
 * Capacidade de disparo do número hoje. Pronto: 200 menos o que já saiu
 * (aquecimento + disparos). Aquecendo: o plano do dia menos o que já saiu.
 * Pausado: zero. A UI desaconselha, mas não proíbe.
 */
export function capacidadeDe(n: NumeroParaCapacidade): CapacidadeDoNumero {
  const dia = Math.min(Math.max(n.currentDay, 1), DIAS_DE_RAMPA);
  const usado = n.dailyEnviadasHoje + n.disparosHoje;
  if (n.status === 'warm') {
    return {
      status: 'pronto',
      dia,
      limiteDiario: LIMITE_DIARIO_PRONTO,
      restantesHoje: Math.max(0, LIMITE_DIARIO_PRONTO - usado),
    };
  }
  if (n.status === 'warming') {
    const plano = planoDoDia(n.currentDay, n.modo);
    return { status: 'aquecendo', dia, limiteDiario: plano, restantesHoje: Math.max(0, plano - usado) };
  }
  return { status: 'pausado', dia, limiteDiario: 0, restantesHoje: 0 };
}

/**
 * Separa o que é problema da infraestrutura (Evolution fora, rede, credencial,
 * instância desconectada) do que é problema do número (não existe no
 * WhatsApp, bloqueado, banido, telefone inválido). Em dúvida é infra: punir o
 * número por um erro que não entendemos era exatamente o bug antigo.
 */
export function classificarErro(err: unknown): TipoDeFalha {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (
    /not on whatsapp|exists["']?\s*:\s*false|invalid jid|blocked|\bban(ned|ido)?\b|telefone inv[aá]lido|n[uú]mero inv[aá]lido/.test(msg)
  ) {
    return 'numero';
  }
  if (/retornou status 4(00|04|22)\b/.test(msg)) return 'numero';
  return 'infra';
}

export function saudeDe(n: Pick<WarmupNumber, 'status' | 'falhasSeguidas'>): SaudeAquecimento {
  if (n.status === 'paused') return 'pausado';
  return n.falhasSeguidas > 0 ? 'atencao' : 'boa';
}

/** Dígitos do telefone, mais a variante BR com/sem o nono dígito (o JID do WhatsApp varia). */
export function variantesDoTelefone(telefone: string): string[] {
  const digitos = (telefone || '').replace(/\D+/g, '');
  if (!digitos) return [];
  const variantes = [digitos];
  if (digitos.startsWith('55')) {
    if (digitos.length === 13 && digitos[4] === '9') {
      variantes.push(digitos.slice(0, 4) + digitos.slice(5));
    } else if (digitos.length === 12) {
      variantes.push(digitos.slice(0, 4) + '9' + digitos.slice(4));
    }
  }
  return variantes;
}

function jidDe(telefone: string): string {
  return `${telefone.replace(/\D+/g, '')}@s.whatsapp.net`;
}

type NumeroComInbox = WarmupNumber & { inbox: { id: string; name: string } | null };

// ============================================
// Service
// ============================================

class AquecimentoService {
  /** Trocável nos testes para tornar sorteios determinísticos. */
  aleatorio: () => number = Math.random;

  private ultimoTickEm: Date | null = null;

  private cacheTelefones = new Map<string, { ate: number; telefones: Set<string> }>();

  // ------------------------------------------
  // Leitura
  // ------------------------------------------

  async listar(accountId: string): Promise<ListaAquecimento> {
    const agora = new Date();
    const conta = await prisma.account.findUnique({
      where: { id: accountId },
      select: { timezone: true, warmupInfraPausaAte: true },
    });
    if (!conta) throw new NotFoundError('Conta');
    const fuso = conta.timezone || FUSO_PADRAO;

    const numeros = (await prisma.warmupNumber.findMany({
      where: { accountId },
      include: { inbox: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    })) as NumeroComInbox[];

    const ativos = numeros.filter((n) => (ATIVOS as readonly string[]).includes(n.status)).length;

    const falhasHoje = numeros.length
      ? await prisma.warmupMessage.count({
          where: {
            status: 'failed',
            senderId: { in: numeros.map((n) => n.id) },
            createdAt: { gte: inicioDoDiaLocal(agora, fuso) },
          },
        })
      : 0;

    const proximaRodada = new Date((this.ultimoTickEm ?? agora).getTime() + 60 * 1000);
    const infraPausaAte =
      conta.warmupInfraPausaAte && conta.warmupInfraPausaAte > agora
        ? conta.warmupInfraPausaAte.toISOString()
        : null;

    return {
      numeros: numeros.map((n) => this.mapear(n, ativos)),
      agora: {
        proximaRodadaEm: (proximaRodada > agora ? proximaRodada : new Date(agora.getTime() + 60 * 1000)).toISOString(),
        janela: { inicio: '08:00', fim: '20:00', fuso },
        trocadasHoje: numeros.reduce((s, n) => s + n.dailyEnviadasHoje, 0),
        falhasHoje,
        infraPausaAte,
      },
    };
  }

  private mapear(n: NumeroComInbox, ativosNaConta: number): NumeroAquecimento {
    const capacidade = capacidadeDe(n);
    let status: StatusAquecimento;
    if (n.status === 'warm') status = 'pronto';
    else if (n.status === 'warming') status = ativosNaConta < 2 ? 'aguardando_parceiro' : 'aquecendo';
    else status = 'pausado';

    return {
      id: n.id,
      inboxId: n.inboxId ?? n.inbox?.id ?? null,
      inboxNome: n.inbox?.name ?? n.displayName ?? null,
      telefone: n.phoneE164.startsWith('+') ? n.phoneE164 : `+${n.phoneE164}`,
      status,
      dia: capacidade.dia,
      modo: n.modo === 'manutencao' ? 'manutencao' : 'rampa',
      hoje: {
        planejadas: planoDoDia(n.currentDay, n.modo),
        enviadas: n.dailyEnviadasHoje,
        recebidas: n.dailyRecebidasHoje,
        disparos: n.disparosHoje,
      },
      saude: saudeDe(n),
      falhasSeguidas: n.falhasSeguidas,
      pausadoMotivo: n.status === 'paused' ? n.pausedReason : null,
      pausadoEm: n.pausadoEm?.toISOString() ?? null,
      prontoEm: n.prontoEm?.toISOString() ?? null,
      limiteDiario: capacidade.limiteDiario,
      restantesHoje: capacidade.restantesHoje,
    };
  }

  /**
   * Últimos 30 dias (fuso da conta), um item por dia, com zeros onde não há
   * registro. Hoje ainda não tem DailyStats (ela nasce na virada do dia), então
   * o item de hoje vem dos contadores ao vivo.
   */
  async historico(accountId: string, id: string, agora: Date = new Date()): Promise<HistoricoDia[]> {
    const n = await this.buscar(accountId, id);
    const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { timezone: true } });
    const fuso = conta?.timezone || FUSO_PADRAO;

    const [dias, falhasHoje] = await Promise.all([
      prisma.warmupDailyStats.findMany({
        where: { numberId: id },
        orderBy: { date: 'desc' },
        take: 30,
      }),
      prisma.warmupMessage.count({
        where: { senderId: id, status: 'failed', createdAt: { gte: inicioDoDiaLocal(agora, fuso) } },
      }),
    ]);
    const porData = new Map(dias.map((d) => [d.date.toISOString().slice(0, 10), d]));

    const hoje = dataLocal(agora, fuso);
    const saida: HistoricoDia[] = [];
    for (let i = 29; i >= 0; i--) {
      const data = dataLocal(new Date(agora.getTime() - i * 24 * 60 * 60 * 1000), fuso);
      const d = porData.get(data);
      if (d) {
        saida.push({ date: data, planned: d.plannedSends, actual: d.actualSends, receives: d.actualReceives, failed: d.failedSends });
      } else if (data === hoje) {
        saida.push({
          date: data,
          planned: planoDoDia(n.currentDay, n.modo),
          actual: n.dailyEnviadasHoje,
          receives: n.dailyRecebidasHoje,
          failed: falhasHoje,
        });
      } else {
        saida.push({ date: data, planned: 0, actual: 0, receives: 0, failed: 0 });
      }
    }
    return saida;
  }

  /**
   * Inboxes WhatsApp da conta que ainda não estão aquecendo. As desconectadas
   * (ou sem telefone) vêm junto com o motivo, para a tela mostrar desabilitado
   * em vez de sumir com elas.
   */
  async inboxesDisponiveis(accountId: string): Promise<InboxDisponivel[]> {
    const [inboxes, emAquecimento] = await Promise.all([
      prisma.inbox.findMany({
        where: { accountId, channelType: 'whatsapp' },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.warmupNumber.findMany({ where: { accountId }, select: { inboxId: true } }),
    ]);
    const ocupadas = new Set(emAquecimento.map((n) => n.inboxId).filter(Boolean));

    return Promise.all(
      inboxes
        .filter((i) => !ocupadas.has(i.id))
        .map(async (inbox): Promise<InboxDisponivel> => {
          const base = { id: inbox.id, nome: inbox.name };
          if (!inbox.evolutionInstance) {
            return { ...base, telefone: null, status: 'sem_instancia', conectada: false, motivo: 'Ainda não pareou o WhatsApp' };
          }
          const conexao = await this.conexaoDaInbox(accountId, inbox.evolutionInstance);
          if (!conexao.conectada) {
            return { ...base, telefone: null, status: conexao.status, conectada: false, motivo: 'Desconectada — escaneie o QR em Canais' };
          }
          if (!conexao.telefone) {
            return { ...base, telefone: null, status: conexao.status, conectada: true, motivo: 'A Evolution não informou o telefone' };
          }
          return { ...base, telefone: conexao.telefone, status: conexao.status, conectada: true, motivo: null };
        })
    );
  }

  private async conexaoDaInbox(
    accountId: string,
    instance: string
  ): Promise<{ conectada: boolean; status: 'open' | 'connecting' | 'close' | 'unknown'; telefone: string | null }> {
    try {
      const status = await evolutionService.getStatus(accountId, instance);
      if (status.state !== 'open') return { conectada: false, status: status.state, telefone: null };
      const telefone = await evolutionService.getConnectedNumber(accountId, instance);
      return { conectada: true, status: 'open', telefone };
    } catch (err) {
      logger.warn('[aquecimento] não consegui consultar a conexão da inbox', {
        accountId,
        instance,
        error: err instanceof Error ? err.message : String(err),
      });
      return { conectada: false, status: 'unknown', telefone: null };
    }
  }

  // ------------------------------------------
  // Ciclo de vida do número
  // ------------------------------------------

  async adicionar(accountId: string, inboxId: string): Promise<NumeroAquecimento> {
    const inbox = await prisma.inbox.findFirst({ where: { id: inboxId, accountId } });
    if (!inbox) throw new NotFoundError('Inbox');
    if (inbox.channelType !== 'whatsapp' || !inbox.evolutionInstance) {
      throw new ValidationError('Esta inbox não é um WhatsApp pareado');
    }

    const jaExiste = await prisma.warmupNumber.findFirst({ where: { accountId, inboxId } });
    if (jaExiste) throw new ConflictError('Este número já está em aquecimento');

    const conexao = await this.conexaoDaInbox(accountId, inbox.evolutionInstance);
    if (!conexao.conectada) {
      throw new ValidationError('O número precisa estar conectado para aquecer');
    }
    if (!conexao.telefone) {
      throw new ValidationError('A Evolution não informou o telefone deste número');
    }

    const agora = new Date();
    try {
      const criado = await prisma.warmupNumber.create({
        data: {
          accountId,
          inboxId: inbox.id,
          evolutionInstance: inbox.evolutionInstance,
          phoneE164: conexao.telefone,
          displayName: inbox.name,
          status: 'warming',
          modo: 'rampa',
          currentDay: 1,
          dailyEnvioPlan: [...RAMPA] as unknown as Prisma.InputJsonValue,
          startedAt: agora,
          lastActivityAt: agora,
        },
        include: { inbox: { select: { id: true, name: true } } },
      });
      this.cacheTelefones.delete(accountId);
      logger.info('[aquecimento] número adicionado', { accountId, numeroId: criado.id, inboxId });
      return this.numero(accountId, criado.id);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictError('Este telefone já está em aquecimento nesta conta');
      }
      throw err;
    }
  }

  async pausar(accountId: string, id: string): Promise<NumeroAquecimento> {
    const n = await this.buscar(accountId, id);
    if (n.status !== 'paused') {
      await prisma.warmupNumber.update({
        where: { id },
        data: { status: 'paused', pausedReason: 'Pausado manualmente', pausadoEm: new Date() },
      });
      logger.info('[aquecimento] número pausado', { accountId, numeroId: id });
    }
    return this.numero(accountId, id);
  }

  /** Volta a aquecer do dia em que parou; zera as falhas e o motivo da pausa. */
  async retomar(accountId: string, id: string): Promise<NumeroAquecimento> {
    const n = await this.buscar(accountId, id);
    if (n.status === 'paused') {
      const pronto = n.modo === 'manutencao' || n.currentDay > DIAS_DE_RAMPA;
      await prisma.warmupNumber.update({
        where: { id },
        data: {
          status: pronto ? 'warm' : 'warming',
          falhasSeguidas: 0,
          pausedReason: null,
          pausadoEm: null,
        },
      });
      logger.info('[aquecimento] número retomado', { accountId, numeroId: id, dia: n.currentDay });
    }
    return this.numero(accountId, id);
  }

  /** Um número no formato da tela (precisa contar os ativos da conta para o 'aguardando_parceiro'). */
  private async numero(accountId: string, id: string): Promise<NumeroAquecimento> {
    const [n, ativos] = await Promise.all([
      prisma.warmupNumber.findFirst({
        where: { id, accountId },
        include: { inbox: { select: { id: true, name: true } } },
      }),
      prisma.warmupNumber.count({ where: { accountId, status: { in: [...ATIVOS] } } }),
    ]);
    if (!n) throw new NotFoundError('Número em aquecimento');
    return this.mapear(n as NumeroComInbox, ativos);
  }

  async remover(accountId: string, id: string): Promise<void> {
    await this.buscar(accountId, id);
    await prisma.warmupNumber.delete({ where: { id } });
    this.cacheTelefones.delete(accountId);
    logger.info('[aquecimento] número removido', { accountId, numeroId: id });
  }

  private async buscar(accountId: string, id: string): Promise<WarmupNumber> {
    const n = await prisma.warmupNumber.findFirst({ where: { id, accountId } });
    if (!n) throw new NotFoundError('Número em aquecimento');
    return n;
  }

  // ------------------------------------------
  // Integração com Disparos e com o webhook
  // ------------------------------------------

  /** Quanto o número ainda pode disparar hoje. Inbox que nunca aqueceu pode pouco (50). */
  async capacidadeDoNumero(accountId: string, inboxId: string): Promise<CapacidadeDoNumero> {
    const n = await prisma.warmupNumber.findFirst({ where: { accountId, inboxId } });
    if (!n) {
      return {
        status: 'nao_aquecido',
        dia: 0,
        limiteDiario: LIMITE_DIARIO_NAO_AQUECIDO,
        restantesHoje: LIMITE_DIARIO_NAO_AQUECIDO,
      };
    }
    return capacidadeDe(n);
  }

  /** O motor de Disparos avisa que enviou pelo número: desconta da capacidade do dia. */
  async registrarEnvioExterno(accountId: string, inboxId: string, qtd = 1): Promise<void> {
    if (qtd <= 0) return;
    await prisma.warmupNumber.updateMany({
      where: { accountId, inboxId },
      data: { disparosHoje: { increment: qtd }, lastActivityAt: new Date() },
    });
  }

  /**
   * O telefone é de um número em aquecimento desta conta? Cache de 60 s por
   * conta — o webhook pergunta a cada mensagem recebida.
   */
  async ehNumeroDeAquecimento(accountId: string, telefoneE164: string): Promise<boolean> {
    const digitos = (telefoneE164 || '').replace(/\D+/g, '');
    if (!digitos) return false;
    const agora = Date.now();
    let entrada = this.cacheTelefones.get(accountId);
    if (!entrada || entrada.ate <= agora) {
      const numeros = await prisma.warmupNumber.findMany({
        where: { accountId },
        select: { phoneE164: true },
      });
      const telefones = new Set<string>();
      for (const n of numeros) for (const v of variantesDoTelefone(n.phoneE164)) telefones.add(v);
      entrada = { ate: agora + CACHE_NUMEROS_TTL_MS, telefones };
      this.cacheTelefones.set(accountId, entrada);
    }
    return entrada.telefones.has(digitos);
  }

  /** Esquece o cache de uma conta (ou de todas). Útil após mudanças fora do service e nos testes. */
  esquecerCache(accountId?: string): void {
    if (accountId) this.cacheTelefones.delete(accountId);
    else this.cacheTelefones.clear();
  }

  /**
   * O webhook já decidiu que a mensagem é de aquecimento e não vai criar nada
   * no Chat. Aqui só fechamos o ciclo: a mensagem que nós mandamos chegou do
   * outro lado → 'delivered'. Se não foi o motor que mandou (alguém mexeu no
   * aparelho), conta como recebida para o número da inbox.
   */
  async registrarMensagemDeAquecimento(input: {
    accountId: string;
    inboxId: string;
    evolutionMsgId: string;
    fromMe: boolean;
  }): Promise<void> {
    if (input.fromMe) return; // eco do que o próprio motor mandou — nada a fazer
    const entregue = await prisma.warmupMessage.updateMany({
      where: { evolutionMsgId: input.evolutionMsgId, status: { in: ['pending', 'sent'] } },
      data: { status: 'delivered' },
    });
    if (entregue.count > 0) return;
    const jaConhecida = await prisma.warmupMessage.count({
      where: { evolutionMsgId: input.evolutionMsgId },
    });
    if (jaConhecida > 0) return; // reentrega do webhook
    await prisma.warmupNumber.updateMany({
      where: { accountId: input.accountId, inboxId: input.inboxId },
      data: { dailyRecebidasHoje: { increment: 1 }, lastActivityAt: new Date() },
    });
  }

  // ------------------------------------------
  // Tick (cron de 60 s)
  // ------------------------------------------

  /**
   * Uma rodada do motor. O lock de advisory garante uma rodada por vez mesmo
   * com réplicas; é a variante `_xact_` porque o Prisma usa um pool — o lock
   * de sessão poderia ser pego numa conexão e "solto" noutra, ficando preso
   * para sempre. Preso à transação, ele some no commit, aconteça o que acontecer.
   */
  async tick(agora: Date = new Date()): Promise<TickResultado> {
    this.ultimoTickEm = agora;
    const pulado: TickResultado = { pulado: true, contas: 0, respostas: 0, novas: 0, falhas: 0, infra: 0 };

    // A "vez" é uma linha no banco, não um advisory lock: segurar uma conexão
    // do pool numa transação de vários minutos (cada resposta "digita" 3–8 s)
    // deixava o resto do motor sem conexão quando o pool é pequeno. O UPDATE é
    // atômico (uma réplica só pega a vez) e, se o processo cair, expira em 9 min.
    await prisma.$executeRaw`
      INSERT INTO motor_leases (nome, ate) VALUES ('aquecimento-tick', now() - interval '1 second')
      ON CONFLICT (nome) DO NOTHING
    `;
    const pegou = await prisma.$executeRaw`
      UPDATE motor_leases
         SET ate = now() + interval '9 minutes', dono = ${String(process.pid)}
       WHERE nome = 'aquecimento-tick' AND ate < now()
    `;
    if (pegou === 0) return pulado;

    try {
      return await this.rodar(agora);
    } finally {
      await prisma
        .$executeRaw`UPDATE motor_leases SET ate = now() WHERE nome = 'aquecimento-tick'`
        .catch(() => undefined);
    }
  }

  /** O trabalho do tick, sem o lock. Exposto para os testes chamarem direto. */
  async rodar(agora: Date = new Date()): Promise<TickResultado> {
    const resultado: TickResultado = { pulado: false, contas: 0, respostas: 0, novas: 0, falhas: 0, infra: 0 };

    const todos = await prisma.warmupNumber.findMany({
      where: { status: { in: [...ATIVOS] } },
      include: { account: { select: { id: true, timezone: true, warmupInfraPausaAte: true } } },
    });

    const porConta = new Map<string, typeof todos>();
    for (const n of todos) {
      const lista = porConta.get(n.accountId) ?? [];
      lista.push(n);
      porConta.set(n.accountId, lista);
    }

    for (const [accountId, numeros] of porConta) {
      resultado.contas++;
      const conta = numeros[0].account;
      const fuso = conta.timezone || FUSO_PADRAO;
      try {
        // 1. Virada de dia (antes de qualquer envio, para o plano ser o de hoje).
        for (const n of numeros) await this.virarDiaSePreciso(n, agora, fuso);

        // 2. Conta pausada por falha de infra.
        if (conta.warmupInfraPausaAte && conta.warmupInfraPausaAte > agora) continue;

        // 3. Fora da janela.
        if (!dentroDaJanela(agora, fuso)) continue;

        // 4. Respostas pendentes.
        const infraNasRespostas = await this.responderPendentes(accountId, agora, resultado);
        if (infraNasRespostas) continue;

        // 5. Novas conversas.
        await this.abrirNovasConversas(accountId, agora, fuso, resultado);
      } catch (err) {
        logger.error('[aquecimento] erro na rodada da conta', {
          accountId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (resultado.respostas + resultado.novas + resultado.falhas + resultado.infra > 0) {
      logger.info('[aquecimento] rodada', { ...resultado });
    }
    return resultado;
  }

  /**
   * Fecha o dia anterior (DailyStats), zera os contadores e avança o dia.
   * Compare-and-swap no currentDay: dois ticks concorrentes não avançam dois
   * dias. Ao chegar no dia 31 o número vira Pronto.
   */
  async virarDiaSePreciso(n: WarmupNumber, agora: Date, fuso: string): Promise<boolean> {
    const hoje = dataLocal(agora, fuso);
    const ultimaAtividade = n.lastActivityAt ?? n.startedAt ?? n.createdAt;
    const ultimoDia = dataLocal(ultimaAtividade, fuso);
    if (ultimoDia === hoje) return false;

    let falhasOntem = 0;
    try {
      falhasOntem = await prisma.warmupMessage.count({
        where: {
          senderId: n.id,
          status: 'failed',
          createdAt: { gte: inicioDoDiaLocal(ultimaAtividade, fuso), lt: inicioDoDiaLocal(agora, fuso) },
        },
      });
    } catch (err) {
      logger.warn('[aquecimento] não contei as falhas de ontem', { numeroId: n.id, error: String(err) });
    }

    try {
      const data = new Date(`${ultimoDia}T12:00:00Z`);
      await prisma.warmupDailyStats.upsert({
        where: { numberId_date: { numberId: n.id, date: data } },
        create: {
          numberId: n.id,
          date: data,
          protocolDay: n.currentDay,
          plannedSends: planoDoDia(n.currentDay, n.modo),
          actualSends: n.dailyEnviadasHoje,
          actualReceives: n.dailyRecebidasHoje,
          failedSends: falhasOntem,
          qualityEnd: n.qualityScore,
          statusEnd: n.status,
        },
        update: {
          actualSends: n.dailyEnviadasHoje,
          actualReceives: n.dailyRecebidasHoje,
          failedSends: falhasOntem,
          statusEnd: n.status,
        },
      });
    } catch (err) {
      logger.warn('[aquecimento] não gravei o histórico do dia', { numeroId: n.id, error: String(err) });
    }

    const novoDia = n.currentDay + 1;
    const promover = n.status === 'warming' && novoDia > DIAS_DE_RAMPA;
    const avancou = await prisma.warmupNumber.updateMany({
      where: { id: n.id, currentDay: n.currentDay },
      data: {
        currentDay: novoDia,
        dailyEnviadasHoje: 0,
        dailyRecebidasHoje: 0,
        disparosHoje: 0,
        lastActivityAt: agora,
        ...(promover ? { status: 'warm', modo: 'manutencao', prontoEm: agora } : {}),
      },
    });
    if (avancou.count === 0) {
      logger.info('[aquecimento] virada de dia já feita por outro tick', { numeroId: n.id });
      return false;
    }
    if (promover) logger.info('[aquecimento] número pronto (dia 31)', { numeroId: n.id });
    return true;
  }

  /** Passo 4: responde as conversas cuja hora chegou. Devolve true se bateu em infra. */
  private async responderPendentes(accountId: string, agora: Date, resultado: TickResultado): Promise<boolean> {
    const pendentes = await prisma.warmupConversation.findMany({
      where: { proximaRespostaEm: { lte: agora }, numberA: { accountId } },
      include: { numberA: true, numberB: true },
      orderBy: { proximaRespostaEm: 'asc' },
      take: RESPOSTAS_POR_TICK,
    });
    for (const conv of pendentes) {
      const r = await this.responder(conv, agora);
      if (r === 'ok') resultado.respostas++;
      else if (r === 'falha_numero') resultado.falhas++;
      else if (r === 'infra') {
        resultado.infra++;
        await this.pausarPorInfra(accountId, agora);
        return true;
      }
    }
    return false;
  }

  /** Passo 5: quem ainda tem cota no dia e não está conversando abre uma conversa. */
  private async abrirNovasConversas(
    accountId: string,
    agora: Date,
    fuso: string,
    resultado: TickResultado
  ): Promise<void> {
    const ativos = await prisma.warmupNumber.findMany({
      where: { accountId, status: { in: [...ATIVOS] } },
    });
    if (ativos.length < 2) return; // aguardando parceiro

    const fracao = fracaoDaJanela(agora, fuso);
    for (const n of ativos) {
      const plano = planoDoDia(n.currentDay, n.modo);
      if (plano <= 0 || n.dailyEnviadasHoje >= plano) continue;
      // Meta proporcional ao tempo de janela decorrido, liberando pelo menos 1.
      const alvo = Math.max(1, Math.ceil(plano * fracao));
      if (n.dailyEnviadasHoje >= alvo) continue;
      if (await this.temConversaAtiva(n.id)) continue;
      if (this.aleatorio() < JITTER_PULA) continue;

      const parceiro = this.escolherParceiro(n, ativos);
      if (!parceiro) continue;

      const r = await this.abrirConversa(n, parceiro, agora);
      if (r === 'ok') {
        resultado.novas++;
        n.dailyEnviadasHoje++;
        parceiro.dailyRecebidasHoje++;
      } else if (r === 'falha_numero') {
        resultado.falhas++;
      } else if (r === 'infra') {
        resultado.infra++;
        await this.pausarPorInfra(accountId, agora);
        return;
      }
    }
  }

  private async temConversaAtiva(numeroId: string): Promise<boolean> {
    const ativa = await prisma.warmupConversation.findFirst({
      where: {
        proximaRespostaEm: { not: null },
        OR: [{ numberAId: numeroId }, { numberBId: numeroId }],
      },
      select: { id: true },
    });
    return Boolean(ativa);
  }

  /** Prioriza quem mais recebeu menos do que mandou (déficit); 30% das vezes sorteia. */
  escolherParceiro(n: Pick<WarmupNumber, 'id'>, ativos: WarmupNumber[]): WarmupNumber | null {
    // O status é lido do objeto em memória: quem foi pausado nesta rodada sai da lista.
    const candidatos = ativos.filter(
      (x) => x.id !== n.id && (ATIVOS as readonly string[]).includes(x.status)
    );
    if (candidatos.length === 0) return null;
    if (this.aleatorio() < 0.3) {
      return candidatos[Math.floor(this.aleatorio() * candidatos.length)];
    }
    return candidatos
      .slice()
      .sort((a, b) => (b.dailyEnviadasHoje - b.dailyRecebidasHoje) - (a.dailyEnviadasHoje - a.dailyRecebidasHoje))[0];
  }

  /** Começa um roteiro novo entre os dois e manda a primeira linha. */
  async abrirConversa(
    n: WarmupNumber,
    parceiro: WarmupNumber,
    agora: Date
  ): Promise<'ok' | 'falha_numero' | 'infra'> {
    const [primeiro, segundo] = [n, parceiro].sort((x, y) => (x.id < y.id ? -1 : 1));
    const roteiro = sortearRoteiro(this.aleatorio);

    const conv = await prisma.warmupConversation.upsert({
      where: { numberAId_numberBId: { numberAId: primeiro.id, numberBId: segundo.id } },
      create: { numberAId: primeiro.id, numberBId: segundo.id, roteiro, passo: 0, isActive: true },
      update: { roteiro, passo: 0, proximaRespostaEm: null, proximoRemetenteId: null, isActive: true },
    });

    const envio = await this.enviar(n, parceiro, roteiro[0], conv.id, agora);
    if (!envio.ok) return envio.tipo === 'numero' ? 'falha_numero' : 'infra';

    await prisma.warmupConversation.update({
      where: { id: conv.id },
      data: this.proximoPasso({ roteiro, passo: 1, remetente: n, destinatario: parceiro, agora, msgId: envio.msgId }),
    });
    return 'ok';
  }

  /**
   * Quem está na vez lê a última mensagem, "digita" e manda a próxima linha.
   * Roteiro acabou → conversa encerra; senão agenda a resposta do outro.
   */
  async responder(
    conv: WarmupConversation & { numberA: WarmupNumber; numberB: WarmupNumber },
    agora: Date
  ): Promise<'ok' | 'falha_numero' | 'infra' | 'encerrada'> {
    const roteiro = Array.isArray(conv.roteiro) ? (conv.roteiro as string[]) : [];
    const remetente = conv.proximoRemetenteId === conv.numberBId ? conv.numberB : conv.numberA;
    const destinatario = remetente.id === conv.numberA.id ? conv.numberB : conv.numberA;

    const ambosAtivos =
      (ATIVOS as readonly string[]).includes(remetente.status) &&
      (ATIVOS as readonly string[]).includes(destinatario.status);
    if (!ambosAtivos || conv.passo >= roteiro.length) {
      await this.encerrar(conv.id);
      return 'encerrada';
    }

    if (conv.ultimoMsgId) {
      await evolutionService.markMessageAsRead(remetente.accountId, {
        instance: remetente.evolutionInstance,
        remoteJid: jidDe(destinatario.phoneE164),
        id: conv.ultimoMsgId,
        fromMe: false,
      });
    }
    await evolutionService.sendPresence(remetente.accountId, {
      instance: remetente.evolutionInstance,
      number: destinatario.phoneE164,
      presence: 'composing',
      delayMs: this.entre(DIGITANDO_MIN_MS, DIGITANDO_MAX_MS),
    });

    const envio = await this.enviar(remetente, destinatario, roteiro[conv.passo], conv.id, agora);
    if (!envio.ok) {
      // Erro do número: a conversa não fica tentando para sempre.
      if (envio.tipo === 'numero') await this.encerrar(conv.id);
      return envio.tipo === 'numero' ? 'falha_numero' : 'infra';
    }

    await prisma.warmupConversation.update({
      where: { id: conv.id },
      data: this.proximoPasso({ roteiro, passo: conv.passo + 1, remetente, destinatario, agora, msgId: envio.msgId }),
    });
    return 'ok';
  }

  private proximoPasso(args: {
    roteiro: string[];
    passo: number;
    remetente: WarmupNumber;
    destinatario: WarmupNumber;
    agora: Date;
    msgId: string | null;
  }): Prisma.WarmupConversationUpdateInput {
    const acabou = args.passo >= args.roteiro.length;
    return {
      passo: args.passo,
      ultimoMsgId: args.msgId,
      lastSenderId: args.remetente.id,
      lastTurnAt: args.agora,
      turnsCount: { increment: 1 },
      proximaRespostaEm: acabou
        ? null
        : new Date(args.agora.getTime() + this.entre(RESPOSTA_MIN_MS, RESPOSTA_MAX_MS)),
      proximoRemetenteId: acabou ? null : args.destinatario.id,
    };
  }

  private async encerrar(conversaId: string): Promise<void> {
    await prisma.warmupConversation.update({
      where: { id: conversaId },
      data: { proximaRespostaEm: null, proximoRemetenteId: null },
    });
  }

  /**
   * Manda uma linha pela Evolution e registra o resultado. Sucesso zera as
   * falhas do remetente e conta enviada/recebida dos dois lados. Erro do
   * número soma falha (5 pausam); erro de infra só é devolvido — quem chamou
   * pausa a conta.
   */
  async enviar(
    remetente: WarmupNumber,
    destinatario: WarmupNumber,
    texto: string,
    conversaId: string,
    agora: Date
  ): Promise<{ ok: true; msgId: string | null } | { ok: false; tipo: TipoDeFalha; erro: string }> {
    try {
      const r = await evolutionService.sendText(remetente.accountId, {
        number: destinatario.phoneE164,
        text: texto,
        instance: remetente.evolutionInstance,
      });
      const msgId = r?.messageId || null;
      await prisma.warmupMessage.create({
        data: {
          conversationId: conversaId,
          senderId: remetente.id,
          receiverId: destinatario.id,
          messageType: 'text',
          content: texto,
          contentSource: 'roteiro',
          evolutionMsgId: msgId,
          status: 'sent',
          sentAt: agora,
        },
      });
      await prisma.warmupNumber.update({
        where: { id: remetente.id },
        data: { dailyEnviadasHoje: { increment: 1 }, falhasSeguidas: 0, lastActivityAt: agora },
      });
      await prisma.warmupNumber.update({
        where: { id: destinatario.id },
        data: { dailyRecebidasHoje: { increment: 1 }, lastActivityAt: agora },
      });
      return { ok: true, msgId };
    } catch (err) {
      const erro = err instanceof Error ? err.message : String(err);
      const tipo = classificarErro(err);
      if (tipo === 'infra') {
        logger.warn('[aquecimento] falha de infraestrutura no envio', {
          accountId: remetente.accountId,
          numeroId: remetente.id,
          erro,
        });
        return { ok: false, tipo, erro };
      }

      await prisma.warmupMessage.create({
        data: {
          conversationId: conversaId,
          senderId: remetente.id,
          receiverId: destinatario.id,
          messageType: 'text',
          content: texto,
          contentSource: 'roteiro',
          status: 'failed',
          errorMessage: erro.slice(0, 1000),
        },
      });
      const falhas = remetente.falhasSeguidas + 1;
      const pausar = falhas >= FALHAS_PARA_PAUSAR;
      await prisma.warmupNumber.update({
        where: { id: remetente.id },
        data: {
          falhasSeguidas: falhas,
          lastActivityAt: agora,
          ...(pausar
            ? { status: 'paused', pausedReason: `${FALHAS_PARA_PAUSAR} falhas seguidas no envio`, pausadoEm: agora }
            : {}),
        },
      });
      remetente.falhasSeguidas = falhas;
      if (pausar) {
        remetente.status = 'paused';
        logger.warn('[aquecimento] número pausado por falhas seguidas', {
          accountId: remetente.accountId,
          numeroId: remetente.id,
          erro,
        });
      }
      return { ok: false, tipo, erro };
    }
  }

  private async pausarPorInfra(accountId: string, agora: Date): Promise<void> {
    const ate = new Date(agora.getTime() + INFRA_PAUSA_MS);
    await prisma.account.update({ where: { id: accountId }, data: { warmupInfraPausaAte: ate } });
    logger.warn('[aquecimento] conta pausada por falha de infraestrutura', {
      accountId,
      ate: ate.toISOString(),
    });
  }

  private entre(min: number, max: number): number {
    return Math.round(min + this.aleatorio() * (max - min));
  }
}

export const aquecimentoService = new AquecimentoService();
