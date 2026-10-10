/**
 * API de integração — contrato antigo de "campanhas"
 * (`/api/integrations/whatsapp/campaigns/*`, chave de API) reapontado pro
 * motor único de disparos (etapa C1, 10/10/2026).
 *
 * O que entra e o que sai continuam com a FORMA documentada em
 * docs/fitpark/API_INTEGRATIONS_WHATSAPP.md: `batchId` é o id do disparo,
 * `status` volta nos nomes antigos (scheduled/running/paused/completed/
 * cancelled) e os "logs" do lote são os envios. O que o motor novo decide
 * sozinho (ritmo 20–60 s, janela 08h–20h, rodízio de números) não é mais
 * configurável — `delaySeconds` é aceito e IGNORADO.
 */
import { prisma } from '../../config/database';
import { disparoService, type DisparoSerializado, type EnvioSerializado, type LinhaDeNumero } from '../disparo.service';
import { whatsappTemplateService } from '../whatsapp-template.service';
import { AppError, NotFoundError, ValidationError } from '../../utils/errors';

// ============================================
// Tipos (os nomes são os do contrato antigo)
// ============================================

export type FonteDaCampanha = 'manual' | 'manual_scheduled' | 'n8n' | 'api' | 'integration';
export const FONTES_DA_CAMPANHA: FonteDaCampanha[] = ['manual', 'manual_scheduled', 'n8n', 'api', 'integration'];

export interface DestinatarioDaCampanha {
  phone: string;
  name?: string | null;
  variables?: Record<string, string> | null;
}

export interface CriarCampanhaInput {
  contactIds?: string[] | null;
  phones?: Array<string | DestinatarioDaCampanha> | null;
  templateId?: string | null;
  content?: string | null;
  defaultVariables?: Record<string, string> | null;
  scheduledAt?: Date | null;
  /** Aceito e ignorado: o ritmo é fixo (20–60 s) — fica aqui só pra não quebrar quem manda. */
  delaySeconds?: number | null;
  triggerName?: string | null;
  campaignType?: string | null;
  inboxId?: string | null;
  metadata?: Record<string, unknown> | null;
  source: FonteDaCampanha;
}

export interface CampanhaCriada {
  batchId: string;
  totalContacts: number;
  scheduled: boolean;
}

export interface BatchAntigo {
  id: string;
  accountId: string;
  keyword: string | null;
  location: string | null;
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  status: string;
  /** null: o motor novo não tem intervalo fixo (20–60 s, com variação). */
  delaySeconds: number | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  scheduledAt: string | null;
  source: string;
  triggerName: string | null;
  metadata: Record<string, unknown>;
  templateId: string | null;
  inboxId: null;
}

export interface LogAntigo {
  id: string;
  accountId: string;
  batchId: string;
  contactName: string;
  phone: string;
  inboxId: null;
  inboxName: string;
  status: string;
  errorMessage: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface FiltrosDeCampanha {
  status?: string | string[];
  source?: string | string[];
  triggerName?: string;
  fromDate?: Date;
  toDate?: Date;
  q?: string;
  campaignType?: string | string[];
  limit?: number;
  offset?: number;
}

// ============================================
// Status: novo ⇄ antigo
// ============================================

const STATUS_DISPARO_NOVO_PARA_ANTIGO: Record<string, string> = {
  agendado: 'scheduled',
  enviando: 'running',
  pausado: 'paused',
  concluido: 'completed',
  cancelado: 'cancelled',
};
const STATUS_DISPARO_ANTIGO_PARA_NOVO: Record<string, string> = Object.fromEntries(
  Object.entries(STATUS_DISPARO_NOVO_PARA_ANTIGO).map(([novo, antigo]) => [antigo, novo])
);

const STATUS_ENVIO_NOVO_PARA_ANTIGO: Record<string, string> = {
  pendente: 'pending',
  enviando: 'pending',
  enviada: 'sent',
  entregue: 'sent',
  lida: 'sent',
  respondeu: 'sent',
  falhou: 'failed',
  cancelado: 'cancelled',
  pulado_optout: 'blocked_optout',
  pulado_invalido: 'skipped_invalid_phone',
  pulado_duplicado: 'skipped_duplicate',
};

export function statusAntigoDoDisparo(status: string): string {
  return STATUS_DISPARO_NOVO_PARA_ANTIGO[status] ?? status;
}

export function statusNovoDoDisparo(statusAntigo: string): string {
  return STATUS_DISPARO_ANTIGO_PARA_NOVO[statusAntigo] ?? statusAntigo;
}

export function statusAntigoDoEnvio(status: string): string {
  return STATUS_ENVIO_NOVO_PARA_ANTIGO[status] ?? status;
}

// ============================================
// Criar
// ============================================

const MAX_DESTINATARIOS = 1000;

function semVazios(obj: Record<string, unknown>): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') saida[k] = v;
  return saida;
}

async function primeiraInboxWhatsappConectada(accountId: string): Promise<string> {
  const inbox = await prisma.inbox.findFirst({
    where: { accountId, channelType: 'whatsapp', active: true, evolutionInstance: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (!inbox) {
    throw new AppError('Nenhum inbox WhatsApp ativo configurado nesta conta', 422, 'NO_WHATSAPP_INBOX');
  }
  return inbox.id;
}

/**
 * Texto da campanha: `content` ou o conteúdo do template da conta
 * (404 se o template não existe — como antes).
 */
async function textoDaCampanha(accountId: string, input: { templateId?: string | null; content?: string | null }): Promise<{ texto: string; templateId: string | null }> {
  if (input.templateId) {
    const template = await whatsappTemplateService.get(input.templateId, accountId);
    return { texto: template.content, templateId: template.id };
  }
  const texto = (input.content ?? '').trim();
  if (!texto) throw new ValidationError('Informe templateId ou content');
  return { texto, templateId: null };
}

/**
 * POST send-batch → um disparo no motor novo.
 * - só contactIds → lista {tipo:'contatos'}; com phones (ou os dois) → lista
 *   {tipo:'numeros'} com objetos {telefone, nome, variaveis, contactId};
 * - inboxId informado, senão a primeira inbox WhatsApp conectada;
 * - triggerName/campaignType/source/metadata vão em `disparos.lista` (rótulo e filtros).
 */
export async function criarCampanha(accountId: string, input: CriarCampanhaInput): Promise<CampanhaCriada> {
  const contactIds = Array.from(new Set((input.contactIds ?? []).filter(Boolean)));
  const phones = (input.phones ?? []).filter(Boolean);
  if (contactIds.length === 0 && phones.length === 0) {
    throw new ValidationError('Informe contactIds ou phones');
  }
  if (contactIds.length + phones.length > MAX_DESTINATARIOS) {
    throw new ValidationError(`No máximo ${MAX_DESTINATARIOS} destinatários por disparo — fragmente em mais de um.`);
  }

  const { texto, templateId } = await textoDaCampanha(accountId, input);
  const inboxId = input.inboxId || (await primeiraInboxWhatsappConectada(accountId));

  const lista = await listaDaCampanha(accountId, contactIds, phones);
  const campaignType = input.campaignType ?? (typeof input.metadata?.campaign_type === 'string' ? input.metadata.campaign_type : null);

  const d = await disparoService.criar(accountId, null, {
    nome: input.triggerName || campaignType || 'API',
    texto,
    lista,
    inboxIds: [inboxId],
    atendeRespostas: 'agente',
    agendadoPara: input.scheduledAt ?? null,
    variaveisPadrao: input.defaultVariables ?? null,
    extrasDaLista: semVazios({
      source: input.source,
      triggerName: input.triggerName,
      campaignType,
      templateId,
      metadata: input.metadata && Object.keys(input.metadata).length > 0 ? input.metadata : null,
    }),
  });

  return { batchId: d.id, totalContacts: d.total + d.optout + d.pulados, scheduled: d.status === 'agendado' };
}

async function listaDaCampanha(
  accountId: string,
  contactIds: string[],
  phones: Array<string | DestinatarioDaCampanha>
): Promise<{ tipo: 'contatos'; contactIds: string[] } | { tipo: 'numeros'; linhas: LinhaDeNumero[] }> {
  if (phones.length === 0) return { tipo: 'contatos', contactIds };

  const linhas: LinhaDeNumero[] = phones.map((p) =>
    typeof p === 'string' ? { telefone: p } : { telefone: p.phone, nome: p.name ?? null, variaveis: p.variables ?? null }
  );
  if (contactIds.length > 0) {
    // Os dois juntos: resolvemos os contatos aqui pra caber numa lista só.
    const contatos = await prisma.contact.findMany({
      where: { accountId, id: { in: contactIds } },
      select: { id: true, nome: true, telefone: true },
    });
    for (const c of contatos) {
      if (c.telefone) linhas.push({ telefone: c.telefone, nome: c.nome, contactId: c.id });
    }
  }
  return { tipo: 'numeros', linhas };
}

// ============================================
// Listar / detalhar
// ============================================

function batchDeDisparo(accountId: string, d: DisparoSerializado): BatchAntigo {
  const lista = d.lista ?? {};
  const metadata = (lista.metadata && typeof lista.metadata === 'object' ? (lista.metadata as Record<string, unknown>) : {}) ?? {};
  return {
    id: d.id,
    accountId,
    keyword: null,
    location: null,
    totalContacts: d.total + d.optout + d.pulados,
    sentCount: d.enviadas,
    failedCount: d.falhas,
    status: statusAntigoDoDisparo(d.status),
    delaySeconds: null,
    startedAt: d.iniciadoEm ?? d.createdAt,
    completedAt: d.concluidoEm,
    createdAt: d.createdAt,
    scheduledAt: d.agendadoPara,
    source: typeof lista.source === 'string' ? lista.source : 'manual',
    triggerName: typeof lista.triggerName === 'string' ? lista.triggerName : null,
    metadata: {
      ...metadata,
      campaign_type: typeof lista.campaignType === 'string' ? lista.campaignType : null,
      name: d.nome,
      respondedCount: d.respondidas,
      optOutCount: d.optout,
      skippedCount: d.pulados,
      inboxIds: d.inboxIds,
    },
    templateId: typeof lista.templateId === 'string' ? lista.templateId : null,
    inboxId: null,
  };
}

function logDeEnvio(accountId: string, batchId: string, e: EnvioSerializado): LogAntigo {
  return {
    id: e.id,
    accountId,
    batchId,
    contactName: e.nome ?? '',
    phone: e.telefone,
    inboxId: null,
    inboxName: e.inboxNome,
    status: statusAntigoDoEnvio(e.status),
    errorMessage: e.erro,
    sentAt: e.enviadoEm,
    createdAt: e.createdAt,
  };
}

function lista<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * GET batches. Filtros por `source`/`triggerName`/`campaignType` olham
 * `disparos.lista` — disparos criados pela tela não carregam `source` e
 * só aparecem sem esse filtro (o `source` deles sai como 'manual').
 */
export async function listarCampanhas(accountId: string, filtros: FiltrosDeCampanha = {}): Promise<BatchAntigo[]> {
  const and: Array<Record<string, unknown>> = [];

  const status = lista(filtros.status).map(statusNovoDoDisparo);
  if (status.length > 0) and.push({ status: { in: status } });

  const sources = lista(filtros.source);
  if (sources.length > 0) and.push({ OR: sources.map((s) => ({ lista: { path: ['source'], equals: s } })) });

  if (filtros.triggerName) and.push({ lista: { path: ['triggerName'], equals: filtros.triggerName } });

  const tipos = lista(filtros.campaignType);
  if (tipos.length > 0) and.push({ OR: tipos.map((t) => ({ lista: { path: ['campaignType'], equals: t } })) });

  if (filtros.fromDate || filtros.toDate) {
    and.push({ createdAt: { ...(filtros.fromDate ? { gte: filtros.fromDate } : {}), ...(filtros.toDate ? { lte: filtros.toDate } : {}) } });
  }

  const q = (filtros.q ?? '').trim();
  if (q) {
    and.push({
      OR: [
        { nome: { contains: q, mode: 'insensitive' } },
        { lista: { path: ['triggerName'], string_contains: q } },
        { lista: { path: ['campaignType'], string_contains: q } },
      ],
    });
  }

  const take = Math.min(Math.max(filtros.limit ?? 200, 1), 500);
  const skip = Math.max(filtros.offset ?? 0, 0);

  const [disparos, inboxes] = await Promise.all([
    prisma.disparo.findMany({
      where: { accountId, ...(and.length > 0 ? { AND: and } : {}) },
      orderBy: { createdAt: 'desc' },
      take,
      skip,
    }),
    prisma.inbox.findMany({ where: { accountId }, select: { id: true, name: true } }),
  ]);
  const nomes = new Map(inboxes.map((i) => [i.id, i.name]));
  return disparos.map((d) => batchDeDisparo(accountId, disparoService.serializarDisparo(d, nomes, null)));
}

/** GET batches/:id — o disparo com todos os envios como "logs" (até 20 páginas = 2000 linhas). */
export async function detalharCampanha(accountId: string, id: string): Promise<BatchAntigo & { logs: LogAntigo[] }> {
  const primeira = await disparoService.detalhe(accountId, id, 1);
  const envios = [...primeira.envios];
  const paginas = Math.min(primeira.paginacao.totalPaginas, 20);
  for (let p = 2; p <= paginas; p++) {
    const seguinte = await disparoService.detalhe(accountId, id, p);
    envios.push(...seguinte.envios);
  }
  return { ...batchDeDisparo(accountId, primeira.disparo), logs: envios.map((e) => logDeEnvio(accountId, id, e)) };
}

/** Telefone de um contato da conta (send-single por contactId). */
export async function telefoneDoContato(accountId: string, contactId: string): Promise<{ telefone: string; nome: string | null }> {
  const c = await prisma.contact.findFirst({ where: { id: contactId, accountId }, select: { nome: true, telefone: true } });
  if (!c) throw new NotFoundError('Contato');
  if (!c.telefone) throw new ValidationError('Contato sem telefone');
  return { telefone: c.telefone, nome: c.nome };
}
