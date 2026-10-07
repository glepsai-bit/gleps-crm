/**
 * ETAPA D — Disparos: motor ÚNICO com fila no banco.
 *
 * Substitui os dois motores antigos (prospecting.dispatch em memória e
 * whatsapp-campaign com cron de 5 min). Aqui a criação decide TUDO de uma
 * vez — quem recebe, por qual número, a que horas — e grava uma linha por
 * contato em `disparo_envios`. O worker (disparo.worker.ts) só executa o que
 * venceu. Nada vive em memória: restart não perde disparo.
 *
 * Regras fechadas com o usuário (contrato 07/10):
 * - rodízio entre os números marcados proporcional à capacidade restante do
 *   dia (aquecimento); contato preso ao número por onde já conversou;
 * - ritmo 20–60 s com variação, 08h–20h no fuso da conta; excedente da cota
 *   do dia vai pras 08h do dia seguinte;
 * - opt-out, duplicados e inválidos ficam de fora já no preview;
 * - 5 falhas seguidas de NÚMERO pausam só aquele número e redistribuem;
 * - "responderam" = resposta inbound na conversa do disparo.
 */
import { Prisma, type Disparo, type DisparoEnvio } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { prisma } from '../config/database';
import { aquecimentoService } from './aquecimento.service';
import { chat } from './ai/chat';
import { hasProvider, type AiProviderName } from './ai/client-factory';
import { disparoAnexoService, type AnexoDeDisparo } from './disparo-anexo.service';
import { contextoDoDisparoParaAgente } from './disparo/contexto';
import {
  calcularHorarios,
  distribuirPorNumero,
  estimarDias,
  FUSO_PADRAO,
  LIMITE_NAO_AQUECIDO,
  variaveisDoContato,
  variaveisUsadas,
  type CapacidadeDoNumero,
  type CotaDoNumero,
  type VariaveisDoEnvio,
} from './disparo/regras';
import { normalizarTelefoneBR } from '../utils/telefone';
import { ConflictError, NotFoundError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

// ============================================
// Tipos
// ============================================

export type ListaDeDisparo =
  | { tipo: 'publico'; audienceId: string }
  | { tipo: 'leads'; etapaTagId?: string | null; tagIds?: string[] | null }
  | { tipo: 'numeros'; linhas: string[]; quantidade?: number };

export type AtendeRespostas = 'agente' | 'humano';

export interface CriarDisparoInput {
  nome?: string | null;
  texto: string;
  variantes?: string[] | null;
  anexo?: (Partial<AnexoDeDisparo> & { id?: string }) | null;
  lista: ListaDeDisparo;
  inboxIds: string[];
  atendeRespostas?: AtendeRespostas;
  /** ISO. Ausente ou no passado = agora. */
  agendadoPara?: string | Date | null;
}

export interface PreviewDaLista {
  total: number;
  vaoReceber: number;
  optout: number;
  duplicados: number;
  invalidos: number;
}

export interface DisparoSerializado {
  id: string;
  nome: string;
  texto: string;
  variantes: string[];
  anexo: AnexoDeDisparo | null;
  lista: Record<string, unknown>;
  listaRotulo: string;
  inboxIds: string[];
  inboxNomes: string[];
  atendeRespostas: AtendeRespostas;
  status: string;
  pausadoMotivo: string | null;
  agendadoPara: string | null;
  iniciadoEm: string | null;
  concluidoEm: string | null;
  previsaoTerminoEm: string | null;
  total: number;
  enviadas: number;
  falhas: number;
  respondidas: number;
  optout: number;
  pulados: number;
  createdAt: string;
}

export interface EnvioSerializado {
  id: string;
  nome: string | null;
  telefone: string;
  inboxId: string;
  inboxNome: string;
  status: string;
  erro: string | null;
  enviadoEm: string | null;
  respondidoEm: string | null;
  naoAntesDe: string;
}

export interface NumeroDisponivel {
  inboxId: string;
  inboxNome: string;
  telefone: string | null;
  conectado: boolean;
  status: CapacidadeDoNumero['status'];
  dia: number;
  limiteDiario: number;
  restantesHoje: number;
  agenteNome: string | null;
  /** Dias que levaria pra N contatos só por este número (quando `contatos` é informado). */
  diasPara?: number;
}

interface Destinatario {
  telefone: string;
  nome: string | null;
  empresa: string | null;
  contactId: string | null;
}

type MotivoDePulo = 'pulado_optout' | 'pulado_invalido' | 'pulado_duplicado';

interface Pulado {
  telefone: string;
  nome: string | null;
  motivo: MotivoDePulo;
}

interface ListaMontada {
  total: number;
  destinatarios: Destinatario[];
  pulados: Pulado[];
  rotulo: string;
  /** O que vai gravado em disparos.lista (sem as linhas coladas). */
  gravada: Record<string, unknown>;
}

const STATUS_EM_ANDAMENTO = ['enviando', 'pausado', 'agendado'];
const STATUS_CONCLUIDOS = ['concluido', 'cancelado'];
/** Status de envio que contam como "chegou" — base do reenvio e da resposta. */
export const STATUS_ENVIADO = ['enviada', 'entregue', 'lida'];
const ORDEM_DE_STATUS: Record<string, number> = { enviada: 1, entregue: 2, lida: 3, respondeu: 4 };
const ENVIOS_POR_PAGINA = 100;
const MAX_LINHAS_COLADAS = 2000;
const DIAS_DE_HISTORICO = 30;
/** Segundos de tolerância pra "agendadoPara" contar como agora. */
const TOLERANCIA_AGORA_S = 60;

const CAPACIDADE_SEM_AQUECIMENTO: CapacidadeDoNumero = {
  inboxId: '',
  status: 'nao_aquecido',
  dia: 0,
  limiteDiario: LIMITE_NAO_AQUECIDO,
  restantesHoje: LIMITE_NAO_AQUECIDO,
};

// ============================================
// Service
// ============================================

class DisparoService {
  // --------------------------------------------
  // Lista: preview e montagem
  // --------------------------------------------

  async previewLista(accountId: string, lista: ListaDeDisparo): Promise<PreviewDaLista> {
    const m = await this.montarDestinatarios(accountId, lista);
    return this.resumoDaLista(m);
  }

  private resumoDaLista(m: ListaMontada): PreviewDaLista {
    const conta = (motivo: MotivoDePulo) => m.pulados.filter((p) => p.motivo === motivo).length;
    return {
      total: m.total,
      vaoReceber: m.destinatarios.length,
      optout: conta('pulado_optout'),
      duplicados: conta('pulado_duplicado'),
      invalidos: conta('pulado_invalido'),
    };
  }

  /**
   * Mesma montagem pro preview e pra criação: fonte → normaliza → dedupe →
   * opt-out. A ordem importa: um número repetido e com opt-out conta uma
   * vez só, como opt-out.
   */
  private async montarDestinatarios(accountId: string, lista: ListaDeDisparo): Promise<ListaMontada> {
    const brutos = await this.carregarFonte(accountId, lista);

    const vistos = new Set<string>();
    const destinatarios: Destinatario[] = [];
    const pulados: Pulado[] = [];
    for (const b of brutos.itens) {
      const telefone = normalizarTelefoneBR(b.telefoneBruto);
      if (!telefone) {
        pulados.push({ telefone: (b.telefoneBruto ?? '').replace(/\D+/g, '').slice(0, 20), nome: b.nome, motivo: 'pulado_invalido' });
        continue;
      }
      if (vistos.has(telefone)) {
        pulados.push({ telefone, nome: b.nome, motivo: 'pulado_duplicado' });
        continue;
      }
      vistos.add(telefone);
      destinatarios.push({ telefone, nome: b.nome, empresa: b.empresa, contactId: b.contactId });
    }

    // Opt-out numa consulta só (política implícita: só 'opted_out' bloqueia —
    // é o que hasConsent faz com o default do sistema).
    if (destinatarios.length > 0) {
      const optados = await prisma.whatsappConsent.findMany({
        where: { accountId, status: 'opted_out', phone: { in: destinatarios.map((d) => d.telefone) } },
        select: { phone: true },
      });
      const bloqueados = new Set(optados.map((o) => o.phone));
      if (bloqueados.size > 0) {
        const ficam: Destinatario[] = [];
        for (const d of destinatarios) {
          if (bloqueados.has(d.telefone)) pulados.push({ telefone: d.telefone, nome: d.nome, motivo: 'pulado_optout' });
          else ficam.push(d);
        }
        destinatarios.length = 0;
        destinatarios.push(...ficam);
      }
    }

    return { total: brutos.itens.length, destinatarios, pulados, rotulo: brutos.rotulo, gravada: brutos.gravada };
  }

  private async carregarFonte(
    accountId: string,
    lista: ListaDeDisparo
  ): Promise<{
    itens: Array<{ telefoneBruto: string | null; nome: string | null; empresa: string | null; contactId: string | null }>;
    rotulo: string;
    gravada: Record<string, unknown>;
  }> {
    if (lista.tipo === 'publico') {
      const audience = await prisma.prospectingAudience.findFirst({
        where: { id: lista.audienceId, accountId },
        select: { id: true, name: true },
      });
      if (!audience) throw new NotFoundError('Público');
      const leads = await prisma.prospectingAudienceLead.findMany({
        where: { audienceId: audience.id },
        select: { name: true, phone: true },
        orderBy: { createdAt: 'asc' },
      });
      return {
        // Público do Google Maps: o "nome" é o da empresa — vale pros dois.
        itens: leads.map((l) => ({ telefoneBruto: l.phone, nome: l.name, empresa: l.name, contactId: null })),
        rotulo: `Público "${audience.name}"`,
        gravada: { tipo: 'publico', audienceId: audience.id, nome: audience.name },
      };
    }

    if (lista.tipo === 'leads') {
      const etapaTagId = lista.etapaTagId || null;
      const tagIds = (lista.tagIds ?? []).filter(Boolean);
      const where: Prisma.ContactWhereInput = { accountId, telefone: { not: null } };
      const and: Prisma.ContactWhereInput[] = [];
      if (etapaTagId) and.push({ leadTags: { some: { tagId: etapaTagId, tag: { accountId } } } });
      if (tagIds.length > 0) and.push({ leadTags: { some: { tagId: { in: tagIds }, tag: { accountId } } } });
      if (and.length > 0) where.AND = and;

      const [contatos, tags] = await Promise.all([
        prisma.contact.findMany({
          where,
          select: { id: true, nome: true, telefone: true, customAttributes: true },
          orderBy: { createdAt: 'asc' },
        }),
        etapaTagId || tagIds.length > 0
          ? prisma.tag.findMany({
              where: { accountId, id: { in: [etapaTagId, ...tagIds].filter((x): x is string => !!x) } },
              select: { id: true, name: true },
            })
          : Promise.resolve([] as Array<{ id: string; name: string }>),
      ]);
      const nomeDaTag = new Map(tags.map((t) => [t.id, t.name]));
      const partes: string[] = [];
      if (etapaTagId) partes.push(`em "${nomeDaTag.get(etapaTagId) ?? 'etapa'}"`);
      if (tagIds.length > 0) partes.push(`com tag ${tagIds.map((t) => `"${nomeDaTag.get(t) ?? 'tag'}"`).join(', ')}`);
      const rotulo = partes.length > 0 ? `Leads ${partes.join(' ')}` : 'Leads do CRM';
      return {
        itens: contatos.map((c) => {
          const attrs = (c.customAttributes as Record<string, unknown> | null) ?? {};
          const empresa = typeof attrs.empresa === 'string' ? attrs.empresa : typeof attrs.company === 'string' ? attrs.company : null;
          return { telefoneBruto: c.telefone, nome: c.nome, empresa, contactId: c.id };
        }),
        rotulo,
        gravada: { tipo: 'leads', etapaTagId, tagIds, rotulo },
      };
    }

    // Números colados: "Nome;telefone" ou só "telefone", uma por linha.
    const linhas = (lista.linhas ?? []).slice(0, MAX_LINHAS_COLADAS);
    const itens = linhas
      .map((linha) => (linha ?? '').trim())
      .filter((linha) => linha !== '')
      .map((linha) => {
        if (linha.includes(';')) {
          const partes = linha.split(';').map((p) => p.trim());
          const telefoneBruto = partes[partes.length - 1] || null;
          const nome = partes.slice(0, -1).join(' ').trim() || null;
          return { telefoneBruto, nome, empresa: null, contactId: null };
        }
        return { telefoneBruto: linha, nome: null, empresa: null, contactId: null };
      });
    return {
      itens,
      rotulo: 'Números colados',
      gravada: { tipo: 'numeros', quantidade: itens.length },
    };
  }

  // --------------------------------------------
  // Criar
  // --------------------------------------------

  async criar(accountId: string, userId: string | null, input: CriarDisparoInput): Promise<DisparoSerializado> {
    const texto = (input.texto ?? '').trim();
    if (!texto) throw new ValidationError('Escreva a mensagem do disparo.');
    const variantes = (input.variantes ?? []).map((v) => (v ?? '').trim()).filter((v) => v !== '').slice(0, 3);

    const montada = await this.montarDestinatarios(accountId, input.lista);
    if (montada.destinatarios.length === 0) {
      const r = this.resumoDaLista(montada);
      throw new ValidationError(
        `Ninguém para receber: ${r.optout} pediram para sair, ${r.duplicados} repetidos, ${r.invalidos} sem telefone válido.`,
        { preview: r }
      );
    }

    const anexo = input.anexo ? await disparoAnexoService.validarReferencia(accountId, input.anexo) : null;

    const quando = this.resolverQuando(input.agendadoPara);
    const nome =
      (input.nome ?? '').trim().slice(0, 120) ||
      `${montada.rotulo} · ${formatInTimeZone(new Date(), FUSO_PADRAO, 'dd/MM HH:mm')}`;

    return this.criarComDestinatarios(accountId, userId, {
      nome,
      texto,
      variantes,
      anexo,
      lista: { ...montada.gravada, rotulo: montada.rotulo },
      inboxIds: input.inboxIds,
      atendeRespostas: input.atendeRespostas === 'humano' ? 'humano' : 'agente',
      quando,
      destinatarios: montada.destinatarios,
      pulados: montada.pulados,
    });
  }

  private resolverQuando(agendadoPara: string | Date | null | undefined): { data: Date; agendado: boolean } {
    const agora = new Date();
    if (!agendadoPara) return { data: agora, agendado: false };
    const data = agendadoPara instanceof Date ? agendadoPara : new Date(agendadoPara);
    if (Number.isNaN(data.getTime())) throw new ValidationError('Data de agendamento inválida.');
    if (data.getTime() <= agora.getTime() + TOLERANCIA_AGORA_S * 1000) return { data: agora, agendado: false };
    return { data, agendado: true };
  }

  /**
   * O coração da criação. Decide número e horário de cada envio e grava tudo
   * numa transação. Usado por `criar` e por `reenviarNaoRespondidos`.
   */
  private async criarComDestinatarios(
    accountId: string,
    userId: string | null,
    p: {
      nome: string;
      texto: string;
      variantes: string[];
      anexo: AnexoDeDisparo | null;
      lista: Record<string, unknown>;
      inboxIds: string[];
      atendeRespostas: AtendeRespostas;
      quando: { data: Date; agendado: boolean };
      destinatarios: Destinatario[];
      pulados: Pulado[];
    }
  ): Promise<DisparoSerializado> {
    const inboxIds = Array.from(new Set(p.inboxIds.filter(Boolean)));
    if (inboxIds.length === 0) throw new ValidationError('Escolha pelo menos um número para disparar.');

    const inboxes = await prisma.inbox.findMany({
      where: { id: { in: inboxIds }, accountId, channelType: 'whatsapp' },
      select: { id: true, name: true, evolutionInstance: true, active: true },
    });
    const achados = new Set(inboxes.map((i) => i.id));
    const faltando = inboxIds.filter((id) => !achados.has(id));
    if (faltando.length > 0) throw new ValidationError('Número não encontrado nesta conta. Recarregue a página.');
    const semWhats = inboxes.filter((i) => !i.evolutionInstance);
    if (semWhats.length > 0) {
      throw new ValidationError(
        `Sem WhatsApp conectado: ${semWhats.map((i) => i.name).join(', ')}. Conecte em Configurações › Inboxes.`
      );
    }

    const fuso = await this.fusoDaConta(accountId);
    const capacidades = await this.capacidades(accountId, inboxIds);

    // Contato preso ao número: quem já tem conversa por um dos números
    // escolhidos continua nele — trocar de número no meio confunde o lead e
    // espalha a mesma pessoa em duas conversas.
    const presos = await this.numerosPresos(accountId, inboxIds, p.destinatarios.map((d) => d.telefone));

    const inboxPorEnvio = distribuirPorNumero(
      p.destinatarios.length,
      capacidades,
      p.destinatarios.map((d) => presos.get(d.telefone) ?? null)
    );
    const cotas: CotaDoNumero[] = capacidades.map((c) => ({
      inboxId: c.inboxId,
      restantesHoje: c.restantesHoje,
      limiteDiario: c.limiteDiario,
    }));
    const horarios = calcularHorarios(p.quando.data, fuso, inboxPorEnvio, cotas);
    const totalVariantes = 1 + p.variantes.length;

    const agora = new Date();
    const status = p.quando.agendado ? 'agendado' : 'enviando';
    const nOptout = p.pulados.filter((x) => x.motivo === 'pulado_optout').length;

    const disparo = await prisma.$transaction(async (tx) => {
      const criado = await tx.disparo.create({
        data: {
          accountId,
          nome: p.nome,
          texto: p.texto,
          variantes: p.variantes,
          anexo: (p.anexo as unknown as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          lista: p.lista as Prisma.InputJsonValue,
          inboxIds,
          atendeRespostas: p.atendeRespostas,
          status,
          agendadoPara: p.quando.agendado ? p.quando.data : null,
          iniciadoEm: p.quando.agendado ? null : agora,
          total: p.destinatarios.length,
          optout: nOptout,
          pulados: p.pulados.length - nOptout,
          criadoPor: userId,
        },
      });

      const linhas: Prisma.DisparoEnvioCreateManyInput[] = p.destinatarios.map((d, k) => ({
        disparoId: criado.id,
        accountId,
        contactId: d.contactId,
        telefone: d.telefone,
        nome: d.nome,
        variaveis: variaveisDoContato(d.nome, d.empresa) as unknown as Prisma.InputJsonValue,
        inboxId: inboxPorEnvio[k],
        variante: k % totalVariantes,
        naoAntesDe: horarios[k],
        status: 'pendente',
      }));
      for (const pu of p.pulados) {
        linhas.push({
          disparoId: criado.id,
          accountId,
          telefone: pu.telefone || 'invalido',
          nome: pu.nome,
          inboxId: inboxIds[0],
          variante: 0,
          naoAntesDe: p.quando.data,
          status: pu.motivo,
        });
      }
      for (let i = 0; i < linhas.length; i += 500) {
        await tx.disparoEnvio.createMany({ data: linhas.slice(i, i + 500) });
      }
      return criado;
    });

    logger.info('[disparo] criado', {
      accountId,
      disparoId: disparo.id,
      status,
      total: p.destinatarios.length,
      pulados: p.pulados.length,
      numeros: inboxIds.length,
    });

    const previsao = horarios.length > 0 ? horarios.reduce((a, b) => (a > b ? a : b)) : null;
    return this.serializarDisparo(disparo, new Map(inboxes.map((i) => [i.id, i.name])), previsao);
  }

  private async capacidades(accountId: string, inboxIds: string[]): Promise<CapacidadeDoNumero[]> {
    return Promise.all(
      inboxIds.map(async (inboxId) => {
        try {
          const c = await aquecimentoService.capacidadeDoNumero(accountId, inboxId);
          return { inboxId, status: c.status, dia: c.dia, limiteDiario: c.limiteDiario, restantesHoje: c.restantesHoje };
        } catch (err) {
          // Aquecimento fora do ar não pode impedir o disparo: trata como
          // número que nunca aqueceu (limite baixo).
          logger.warn('[disparo] capacidadeDoNumero falhou; usando limite de não aquecido', {
            accountId,
            inboxId,
            error: err instanceof Error ? err.message : String(err),
          });
          return { ...CAPACIDADE_SEM_AQUECIMENTO, inboxId };
        }
      })
    );
  }

  private async numerosPresos(accountId: string, inboxIds: string[], telefones: string[]): Promise<Map<string, string>> {
    const presos = new Map<string, string>();
    if (telefones.length === 0 || inboxIds.length < 2) return presos;
    const conversas = await prisma.conversation.findMany({
      where: {
        accountId,
        inboxId: { in: inboxIds },
        externalId: { in: telefones.map((t) => `${t}@s.whatsapp.net`) },
      },
      select: { externalId: true, inboxId: true },
      orderBy: { updatedAt: 'desc' },
    });
    for (const c of conversas) {
      const telefone = (c.externalId ?? '').split('@')[0];
      if (telefone && !presos.has(telefone)) presos.set(telefone, c.inboxId);
    }
    return presos;
  }

  private async fusoDaConta(accountId: string): Promise<string> {
    const conta = await prisma.account.findUnique({ where: { id: accountId }, select: { timezone: true } });
    return conta?.timezone?.trim() || FUSO_PADRAO;
  }

  // --------------------------------------------
  // Listar / detalhe / números
  // --------------------------------------------

  async listar(accountId: string): Promise<{ emAndamento: DisparoSerializado[]; concluidos: DisparoSerializado[] }> {
    const desde = new Date(Date.now() - DIAS_DE_HISTORICO * 24 * 60 * 60 * 1000);
    const [emAndamento, concluidos, inboxes] = await Promise.all([
      prisma.disparo.findMany({
        where: { accountId, status: { in: STATUS_EM_ANDAMENTO } },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.disparo.findMany({
        where: {
          accountId,
          status: { in: STATUS_CONCLUIDOS },
          OR: [{ concluidoEm: { gte: desde } }, { concluidoEm: null, updatedAt: { gte: desde } }],
        },
        orderBy: [{ concluidoEm: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.inbox.findMany({ where: { accountId }, select: { id: true, name: true } }),
    ]);
    const nomes = new Map(inboxes.map((i) => [i.id, i.name]));

    // Previsão de término = último nao_antes_de pendente, numa consulta só.
    const previsao = new Map<string, Date>();
    if (emAndamento.length > 0) {
      const grupos = await prisma.disparoEnvio.groupBy({
        by: ['disparoId'],
        where: { disparoId: { in: emAndamento.map((d) => d.id) }, status: 'pendente' },
        _max: { naoAntesDe: true },
      });
      for (const g of grupos) if (g._max.naoAntesDe) previsao.set(g.disparoId, g._max.naoAntesDe);
    }

    return {
      emAndamento: emAndamento.map((d) => this.serializarDisparo(d, nomes, previsao.get(d.id) ?? null)),
      concluidos: concluidos.map((d) => this.serializarDisparo(d, nomes, null)),
    };
  }

  async detalhe(
    accountId: string,
    id: string,
    page = 1,
    status?: string | null
  ): Promise<{ disparo: DisparoSerializado; envios: EnvioSerializado[]; paginacao: { page: number; totalPaginas: number; total: number } }> {
    const disparo = await this.requerDisparo(accountId, id);
    const pagina = Math.max(1, Math.floor(page || 1));
    const where: Prisma.DisparoEnvioWhereInput = { disparoId: id, ...(status ? { status } : {}) };
    const [envios, total, inboxes, previsaoGrupo] = await Promise.all([
      prisma.disparoEnvio.findMany({
        where,
        orderBy: [{ naoAntesDe: 'asc' }, { createdAt: 'asc' }],
        skip: (pagina - 1) * ENVIOS_POR_PAGINA,
        take: ENVIOS_POR_PAGINA,
      }),
      prisma.disparoEnvio.count({ where }),
      prisma.inbox.findMany({ where: { accountId }, select: { id: true, name: true } }),
      prisma.disparoEnvio.aggregate({ where: { disparoId: id, status: 'pendente' }, _max: { naoAntesDe: true } }),
    ]);
    const nomes = new Map(inboxes.map((i) => [i.id, i.name]));
    return {
      disparo: this.serializarDisparo(disparo, nomes, previsaoGrupo._max.naoAntesDe ?? null),
      envios: envios.map((e) => this.serializarEnvio(e, nomes)),
      paginacao: { page: pagina, totalPaginas: Math.max(1, Math.ceil(total / ENVIOS_POR_PAGINA)), total },
    };
  }

  /**
   * Números WhatsApp da conta (conectados ou não) com a capacidade de hoje
   * vinda do aquecimento, o agente de IA do fluxo publicado que atende a
   * inbox, e quantos pediram para sair. `contatos` (opcional) devolve a
   * estimativa de dias pra essa quantidade.
   */
  async numerosDisponiveis(
    accountId: string,
    contatos?: number | null
  ): Promise<{ numeros: NumeroDisponivel[]; optouts: number; estimativa: { contatos: number; dias: number } | null }> {
    const [inboxes, aquecidos, flows, optouts] = await Promise.all([
      prisma.inbox.findMany({
        where: { accountId, channelType: 'whatsapp' },
        select: { id: true, name: true, evolutionInstance: true, active: true },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.warmupNumber.findMany({
        where: { accountId, inboxId: { not: null } },
        select: { inboxId: true, phoneE164: true },
      }),
      prisma.flow.findMany({
        where: { accountId, status: 'active' },
        select: { inboxIds: true, graph: true },
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.whatsappConsent.count({ where: { accountId, status: 'opted_out' } }),
    ]);

    const telefonePorInbox = new Map<string, string>();
    for (const a of aquecidos) if (a.inboxId) telefonePorInbox.set(a.inboxId, a.phoneE164);

    // Agente do fluxo publicado: o primeiro fluxo ativo que cobre a inbox
    // (inboxIds vazio = todas), nó 'ai.atender' → agentId → nome.
    const agentIdPorInbox = new Map<string, string>();
    for (const inbox of inboxes) {
      for (const f of flows) {
        const ids = Array.isArray(f.inboxIds) ? (f.inboxIds as string[]) : [];
        if (ids.length > 0 && !ids.includes(inbox.id)) continue;
        const nodes = ((f.graph as { nodes?: Array<{ type?: string; config?: Record<string, unknown> }> } | null)?.nodes ?? []);
        const no = nodes.find((n) => n?.type === 'ai.atender' && typeof n.config?.agentId === 'string' && n.config.agentId);
        if (no) {
          agentIdPorInbox.set(inbox.id, no.config!.agentId as string);
          break;
        }
      }
    }
    const agentIds = Array.from(new Set(agentIdPorInbox.values()));
    const agentes =
      agentIds.length > 0
        ? await prisma.aiAgent.findMany({ where: { accountId, id: { in: agentIds } }, select: { id: true, name: true } })
        : [];
    const nomeDoAgente = new Map(agentes.map((a) => [a.id, a.name]));

    const capacidades = await this.capacidades(accountId, inboxes.map((i) => i.id));
    const capPorInbox = new Map(capacidades.map((c) => [c.inboxId, c]));

    const numeros: NumeroDisponivel[] = inboxes.map((i) => {
      const c = capPorInbox.get(i.id) ?? { ...CAPACIDADE_SEM_AQUECIMENTO, inboxId: i.id };
      const cota: CotaDoNumero = { inboxId: i.id, restantesHoje: c.restantesHoje, limiteDiario: c.limiteDiario };
      const agentId = agentIdPorInbox.get(i.id);
      return {
        inboxId: i.id,
        inboxNome: i.name,
        telefone: telefonePorInbox.get(i.id) ?? null,
        conectado: Boolean(i.active && i.evolutionInstance),
        status: c.status,
        dia: c.dia,
        limiteDiario: c.limiteDiario,
        restantesHoje: c.restantesHoje,
        agenteNome: agentId ? (nomeDoAgente.get(agentId) ?? null) : null,
        ...(contatos && contatos > 0 ? { diasPara: estimarDias(contatos, [cota]) } : {}),
      };
    });

    const estimativa =
      contatos && contatos > 0
        ? {
            contatos,
            dias: estimarDias(
              contatos,
              capacidades.map((c) => ({ inboxId: c.inboxId, restantesHoje: c.restantesHoje, limiteDiario: c.limiteDiario }))
            ),
          }
        : null;

    return { numeros, optouts, estimativa };
  }

  // --------------------------------------------
  // Ações
  // --------------------------------------------

  async pausar(accountId: string, id: string): Promise<DisparoSerializado> {
    const d = await this.requerDisparo(accountId, id);
    if (!['enviando', 'agendado'].includes(d.status)) {
      throw new ValidationError(`Não dá para pausar um disparo ${this.statusPorExtenso(d.status)}.`);
    }
    const atualizado = await prisma.disparo.update({
      where: { id },
      data: { status: 'pausado', pausadoMotivo: 'Pausado por você' },
    });
    return this.serializarDisparo(atualizado, await this.nomesDasInboxes(accountId), null);
  }

  /**
   * Retomar recalcula os horários dos pendentes a partir de agora — os
   * antigos já venceram e, sem recalcular, o worker mandaria tudo de uma vez.
   */
  async retomar(accountId: string, id: string): Promise<DisparoSerializado> {
    const d = await this.requerDisparo(accountId, id);
    if (d.status !== 'pausado') throw new ValidationError(`Só dá para retomar um disparo pausado (este está ${this.statusPorExtenso(d.status)}).`);

    const agora = new Date();
    const agendadoNoFuturo = !!d.agendadoPara && d.agendadoPara.getTime() > agora.getTime() + TOLERANCIA_AGORA_S * 1000;
    const inicio = agendadoNoFuturo ? d.agendadoPara! : agora;
    await this.reprogramarPendentes(d, inicio, d.inboxIds);

    const atualizado = await prisma.disparo.update({
      where: { id },
      data: {
        status: agendadoNoFuturo ? 'agendado' : 'enviando',
        pausadoMotivo: null,
        iniciadoEm: agendadoNoFuturo ? d.iniciadoEm : (d.iniciadoEm ?? agora),
        // Retomar zera as falhas seguidas: o usuário já viu e decidiu seguir.
        falhasSeguidas: {},
      },
    });
    return this.serializarDisparo(atualizado, await this.nomesDasInboxes(accountId), null);
  }

  async cancelar(accountId: string, id: string): Promise<DisparoSerializado> {
    const d = await this.requerDisparo(accountId, id);
    if (!STATUS_EM_ANDAMENTO.includes(d.status)) {
      throw new ValidationError(`Este disparo já está ${this.statusPorExtenso(d.status)}.`);
    }
    const agora = new Date();
    const atualizado = await prisma.$transaction(async (tx) => {
      await tx.disparoEnvio.updateMany({
        where: { disparoId: id, status: { in: ['pendente', 'enviando'] } },
        data: { status: 'cancelado', erro: 'Cancelado pelo usuário' },
      });
      return tx.disparo.update({ where: { id }, data: { status: 'cancelado', concluidoEm: agora } });
    });
    return this.serializarDisparo(atualizado, await this.nomesDasInboxes(accountId), null);
  }

  /**
   * Disparo novo com quem recebeu e não respondeu (enviada/entregue/lida),
   * mesmo texto e números, nome "<nome> · reenvio".
   */
  async reenviarNaoRespondidos(accountId: string, id: string, userId: string | null): Promise<DisparoSerializado> {
    const d = await this.requerDisparo(accountId, id);
    const envios = await prisma.disparoEnvio.findMany({
      where: { disparoId: id, status: { in: STATUS_ENVIADO } },
      select: { telefone: true, nome: true, variaveis: true, contactId: true },
      orderBy: { naoAntesDe: 'asc' },
    });
    if (envios.length === 0) throw new ValidationError('Ninguém para reenviar: todos responderam ou nada foi entregue.');

    const destinatarios: Destinatario[] = envios.map((e) => ({
      telefone: e.telefone,
      nome: e.nome,
      empresa: ((e.variaveis as VariaveisDoEnvio | null)?.empresa ?? null) || null,
      contactId: e.contactId,
    }));
    // Quem pediu para sair DEPOIS do original fica de fora do reenvio.
    const optados = await prisma.whatsappConsent.findMany({
      where: { accountId, status: 'opted_out', phone: { in: destinatarios.map((x) => x.telefone) } },
      select: { phone: true },
    });
    const bloqueados = new Set(optados.map((o) => o.phone));
    const ficam = destinatarios.filter((x) => !bloqueados.has(x.telefone));
    const pulados: Pulado[] = destinatarios
      .filter((x) => bloqueados.has(x.telefone))
      .map((x) => ({ telefone: x.telefone, nome: x.nome, motivo: 'pulado_optout' as const }));
    if (ficam.length === 0) throw new ValidationError('Ninguém para reenviar: todos pediram para sair.');

    const listaOriginal = (d.lista as Record<string, unknown> | null) ?? {};
    return this.criarComDestinatarios(accountId, userId, {
      nome: `${d.nome} · reenvio`.slice(0, 120),
      texto: d.texto,
      variantes: Array.isArray(d.variantes) ? (d.variantes as string[]) : [],
      anexo: (d.anexo as unknown as AnexoDeDisparo | null) ?? null,
      lista: { ...listaOriginal, tipo: 'reenvio', origemId: d.id, quantidade: ficam.length, rotulo: `Reenvio de "${d.nome}"` },
      inboxIds: d.inboxIds,
      atendeRespostas: d.atendeRespostas === 'humano' ? 'humano' : 'agente',
      quando: { data: new Date(), agendado: false },
      destinatarios: ficam,
      pulados,
    });
  }

  /**
   * Recalcula nao_antes_de (e opcionalmente o número) dos pendentes de um
   * disparo a partir de `inicio`, só entre `inboxIds`. Usado por retomar e
   * pela redistribuição do worker.
   */
  async reprogramarPendentes(d: Disparo, inicio: Date, inboxIds: string[], apenasDaInbox?: string): Promise<number> {
    const pendentes = await prisma.disparoEnvio.findMany({
      where: { disparoId: d.id, status: 'pendente', ...(apenasDaInbox ? { inboxId: apenasDaInbox } : {}) },
      select: { id: true, inboxId: true, telefone: true },
      orderBy: [{ naoAntesDe: 'asc' }, { createdAt: 'asc' }],
    });
    if (pendentes.length === 0) return 0;
    const alvo = inboxIds.length > 0 ? inboxIds : d.inboxIds;
    const fuso = await this.fusoDaConta(d.accountId);
    const capacidades = await this.capacidades(d.accountId, alvo);
    const presos = await this.numerosPresos(d.accountId, alvo, pendentes.map((p) => p.telefone));
    const inboxPorEnvio = distribuirPorNumero(
      pendentes.length,
      capacidades,
      pendentes.map((p) => {
        // Mantém o número atual quando ele continua elegível; senão, o preso
        // por conversa; senão o rodízio decide.
        if (alvo.includes(p.inboxId)) return p.inboxId;
        return presos.get(p.telefone) ?? null;
      })
    );
    const horarios = calcularHorarios(
      inicio,
      fuso,
      inboxPorEnvio,
      capacidades.map((c) => ({ inboxId: c.inboxId, restantesHoje: c.restantesHoje, limiteDiario: c.limiteDiario }))
    );
    const ids = pendentes.map((p) => p.id);
    const quandos = horarios.map((h) => h.toISOString());
    await prisma.$executeRaw`
      UPDATE disparo_envios AS e
         SET inbox_id = v.inbox_id, nao_antes_de = v.quando, updated_at = now()
        FROM (
          SELECT unnest(${ids}::uuid[]) AS id,
                 unnest(${inboxPorEnvio}::uuid[]) AS inbox_id,
                 unnest(${quandos}::text[])::timestamptz AS quando
        ) AS v
       WHERE e.id = v.id
    `;
    return pendentes.length;
  }

  // --------------------------------------------
  // Ganchos do inbound / ack / agente
  // --------------------------------------------

  /** Resposta inbound na conversa de um disparo → 'respondeu' (uma vez por envio). */
  async registrarRespostaDeDisparo(conversationId: string): Promise<number> {
    if (!conversationId) return 0;
    const envios = await prisma.disparoEnvio.findMany({
      where: { conversationId, status: { in: STATUS_ENVIADO } },
      select: { id: true, disparoId: true },
    });
    if (envios.length === 0) return 0;
    const agora = new Date();
    const porDisparo = new Map<string, number>();
    for (const e of envios) porDisparo.set(e.disparoId, (porDisparo.get(e.disparoId) ?? 0) + 1);
    await prisma.$transaction([
      prisma.disparoEnvio.updateMany({
        where: { id: { in: envios.map((e) => e.id) }, status: { in: STATUS_ENVIADO } },
        data: { status: 'respondeu', respondidoEm: agora },
      }),
      ...Array.from(porDisparo.entries()).map(([disparoId, n]) =>
        prisma.disparo.update({ where: { id: disparoId }, data: { respondidas: { increment: n } } })
      ),
    ]);
    return envios.length;
  }

  /** Ack da Evolution: só sobe (enviada → entregue → lida), nunca desce. */
  async atualizarStatusPorMsgId(evolutionMsgId: string, novo: 'entregue' | 'lida'): Promise<number> {
    if (!evolutionMsgId) return 0;
    const abaixo = Object.entries(ORDEM_DE_STATUS)
      .filter(([, ordem]) => ordem < ORDEM_DE_STATUS[novo])
      .map(([s]) => s);
    const r = await prisma.disparoEnvio.updateMany({
      where: { evolutionMsgId, status: { in: abaixo } },
      data: { status: novo },
    });
    return r.count;
  }

  /** Bloco "CONTEXTO DO DISPARO" pro agente de IA (null = conversa comum). */
  async contextoParaAgente(conversationId: string): Promise<string | null> {
    return contextoDoDisparoParaAgente(conversationId);
  }

  /** A conversa está marcada pra atendimento humano (flag reusada do live attendance). */
  atendimentoHumano(conversation: { customAttributes?: unknown } | null | undefined): boolean {
    const attrs = (conversation?.customAttributes as Record<string, unknown> | null) ?? {};
    return attrs.human_active === true;
  }

  // --------------------------------------------
  // Variar com IA
  // --------------------------------------------

  /**
   * 5 reescritas do texto mantendo as {{variáveis}} e sem inventar promessas.
   * Usa o provedor que a conta tem chave (OpenAI, senão Anthropic); 409 sem chave.
   */
  async variarComIA(accountId: string, texto: string): Promise<string[]> {
    const base = (texto ?? '').trim();
    if (!base) throw new ValidationError('Escreva a mensagem antes de pedir variações.');

    let provider: AiProviderName | null = null;
    if (await hasProvider(accountId, 'openai')) provider = 'openai';
    else if (await hasProvider(accountId, 'anthropic')) provider = 'anthropic';
    if (!provider) {
      throw new ConflictError('Esta conta não tem chave de IA configurada. Cadastre em Administração › Integrações.');
    }

    const usadas = variaveisUsadas(base);
    const system =
      'Você reescreve mensagens curtas de WhatsApp em português do Brasil para uma empresa falar com clientes.\n' +
      'Regras: produza exatamente 5 variações do texto, com o MESMO sentido e a MESMA intenção; ' +
      'mantenha todas as variáveis entre chaves duplas exatamente como estão (ex.: {{nome}}, {{primeiro_nome}}, {{empresa}}); ' +
      'não invente promessas, descontos, prazos, valores ou garantias que não estejam no original; ' +
      'não acrescente links nem emojis que o original não tenha; ' +
      'tamanho parecido com o original; tom natural de conversa, sem parecer propaganda.';
    const res = await chat({
      accountId,
      provider,
      system,
      messages: [{ role: 'user', content: `Texto original:\n${base}` }],
      jsonSchema: {
        name: 'variacoes_do_disparo',
        schema: {
          type: 'object',
          properties: {
            variacoes: { type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 5 },
          },
          required: ['variacoes'],
          additionalProperties: false,
        },
      },
      temperature: 0.8,
      maxTokens: 1200,
    });

    let variacoes: string[] = [];
    try {
      const parsed = JSON.parse(res.text) as { variacoes?: unknown };
      if (Array.isArray(parsed.variacoes)) variacoes = parsed.variacoes.filter((v): v is string => typeof v === 'string');
    } catch {
      variacoes = res.text.split(/\n+/).map((l) => l.replace(/^\s*(\d+[.)]|[-*•])\s*/, '').trim()).filter(Boolean);
    }

    // Variação que perdeu uma variável quebraria o render: fica de fora.
    const validas = variacoes
      .map((v) => v.trim())
      .filter((v) => v && v !== base)
      .filter((v) => {
        const dela = variaveisUsadas(v);
        for (const u of usadas) if (!dela.has(u)) return false;
        return true;
      });
    const unicas = Array.from(new Set(validas)).slice(0, 5);
    if (unicas.length === 0) throw new ValidationError('A IA não devolveu variações válidas. Tente de novo.');
    return unicas;
  }

  // --------------------------------------------
  // Helpers
  // --------------------------------------------

  private async requerDisparo(accountId: string, id: string): Promise<Disparo> {
    const d = await prisma.disparo.findFirst({ where: { id, accountId } });
    if (!d) throw new NotFoundError('Disparo');
    return d;
  }

  private async nomesDasInboxes(accountId: string): Promise<Map<string, string>> {
    const inboxes = await prisma.inbox.findMany({ where: { accountId }, select: { id: true, name: true } });
    return new Map(inboxes.map((i) => [i.id, i.name]));
  }

  private statusPorExtenso(status: string): string {
    const nomes: Record<string, string> = {
      agendado: 'agendado',
      enviando: 'em envio',
      pausado: 'pausado',
      concluido: 'concluído',
      cancelado: 'cancelado',
    };
    return nomes[status] ?? status;
  }

  serializarDisparo(d: Disparo, nomes: Map<string, string>, previsao: Date | null): DisparoSerializado {
    const lista = (d.lista as Record<string, unknown> | null) ?? {};
    return {
      id: d.id,
      nome: d.nome,
      texto: d.texto,
      variantes: Array.isArray(d.variantes) ? (d.variantes as string[]) : [],
      anexo: (d.anexo as unknown as AnexoDeDisparo | null) ?? null,
      lista,
      listaRotulo: typeof lista.rotulo === 'string' ? lista.rotulo : this.rotuloPadrao(lista),
      inboxIds: d.inboxIds,
      inboxNomes: d.inboxIds.map((id) => nomes.get(id) ?? 'Número removido'),
      atendeRespostas: d.atendeRespostas === 'humano' ? 'humano' : 'agente',
      status: d.status,
      pausadoMotivo: d.pausadoMotivo ?? null,
      agendadoPara: d.agendadoPara?.toISOString() ?? null,
      iniciadoEm: d.iniciadoEm?.toISOString() ?? null,
      concluidoEm: d.concluidoEm?.toISOString() ?? null,
      previsaoTerminoEm: previsao?.toISOString() ?? null,
      total: d.total,
      enviadas: d.enviadas,
      falhas: d.falhas,
      respondidas: d.respondidas,
      optout: d.optout,
      pulados: d.pulados,
      createdAt: d.createdAt.toISOString(),
    };
  }

  private rotuloPadrao(lista: Record<string, unknown>): string {
    if (lista.tipo === 'publico') return 'Público salvo';
    if (lista.tipo === 'leads') return 'Leads do CRM';
    if (lista.tipo === 'reenvio') return 'Reenvio';
    return 'Números colados';
  }

  serializarEnvio(e: DisparoEnvio, nomes: Map<string, string>): EnvioSerializado {
    return {
      id: e.id,
      nome: e.nome ?? null,
      telefone: e.telefone,
      inboxId: e.inboxId,
      inboxNome: nomes.get(e.inboxId) ?? 'Número removido',
      status: e.status,
      erro: e.erro ?? null,
      enviadoEm: e.enviadoEm?.toISOString() ?? null,
      respondidoEm: e.respondidoEm?.toISOString() ?? null,
      naoAntesDe: e.naoAntesDe.toISOString(),
    };
  }
}

export const disparoService = new DisparoService();
