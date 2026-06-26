import type { WhatsappConsent } from '@prisma/client';
import { prisma } from '../config/database';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';
import { ValidationError } from '../utils/errors';
import { escapeLike } from '../utils/helpers';
import { logger } from '../utils/logger';

// ============================================
// Types
// ============================================

export type ConsentSource = 'manual' | 'auto_keyword' | 'import' | 'api' | string;

export interface ConsentOptions {
  contactId?: string;
  source?: ConsentSource;
  reason?: string;
}

export interface ListOptedOutFilters {
  fromDate?: Date;
  toDate?: Date;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface ListOptedOutResult {
  data: Array<WhatsappConsent & { contactName?: string | null }>;
  total: number;
}

// ============================================
// Constants
// ============================================

// BUG-006: regex original cobria variantes (descadastrar, remover, opt-out…).
// BUG-041: stripDiacritics antes do test() (cancelár → cancelar).
// BUG-045 (HIGH, false positive academia FitPark): a regex pegava "PARAR a aula",
// "remover do treino", "vou sair do crossfit" etc. Estreitamos em 3 eixos:
//   1) `remover` foi REMOVIDO do regex de palavra simples (ambíguo demais —
//      "remover do treino", "remover horário", "remover meu nome do grupo");
//   2) bordas reforçadas: além de \b, exigimos que o caractere imediatamente
//      antes/depois NÃO seja letra (cobre casos onde \b sozinho não basta
//      após acentos/diacríticos removidos);
//   3) phrases multi-palavra dedicadas (`sair lista`, `cancelar inscricao`,
//      `parar mensagens`, `descadastrar`) — quando o usuário usa uma frase
//      específica, aceitamos independente do tamanho da mensagem.
// O regex single-word só dispara para mensagens curtas (≤ 30 chars), conforme
// gate aplicado em `handleInboundOptOut`.
const OPT_OUT_SINGLE_WORD_REGEX = /(?:^|[^\p{L}])(sair|parar|stop|cancelar|opt[\s\-_]?out|descadastrar)(?:$|[^\p{L}])/iu;
const OPT_OUT_PHRASE_REGEX = /\b(sair\s+(da\s+)?lista|cancelar\s+inscricao|parar\s+mensagens|descadastrar)\b/i;
const OPT_OUT_MAX_SHORT_LEN = 30;

/**
 * Remove acentos/diacríticos de uma string usando decomposição NFD.
 * Ex: "Não quero mais, cancelár!" → "Nao quero mais, cancelar!"
 * Usado em handleInboundOptOut para que o regex de palavra-chave aceite
 * variações comuns de digitação em português.
 */
function stripDiacritics(input: string): string {
  return input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * BUG-044: mitigacao de CSV injection.
 *
 * Planilhas (Excel, Google Sheets, LibreOffice) interpretam celulas que comecam
 * com `=`, `+`, `-`, `@`, `\t`, `\r` ou `\n` como formulas. Se um atacante
 * conseguir injetar uma string como `=cmd|'/c calc'!A1` em qualquer campo
 * exportado (ex.: `reason` no opt-out automatico por palavra-chave), abrir o
 * CSV pode disparar execucao arbitraria / exfiltracao via planilha.
 *
 * Estrategia: se o primeiro caractere for um dos acima, prefixar `'`
 * (aspas simples) \u2014 convencao amplamente reconhecida que faz a planilha
 * tratar a celula como texto literal. Em seguida aplicar o quoting padrao
 * de CSV (RFC 4180): dobrar aspas duplas e envolver em `"..."` quando a
 * celula contem `"`, `,`, `\n` ou `\r`.
 *
 * Aplicar em TODAS as celulas de qualquer CSV exportado.
 */
function escapeCsv(value: unknown): string {
  let str = value === null || value === undefined ? '' : String(value);

  // Mitigacao CSV injection \u2014 prefixa aspas simples se primeiro char e perigoso.
  if (str.length > 0 && /^[=+\-@\t\r\n]/.test(str)) {
    str = `'${str}`;
  }

  // RFC 4180 \u2014 escape de aspas e wrap quando necessario.
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// ============================================
// Consent policy
// ============================================

/**
 * Política de consent suportada pelo `hasConsent`:
 * - 'implicit_optin': ausência de registro = consent presumido (default histórico).
 * - 'strict_optin'  : ausência de registro = SEM consent (exige opt-in explícito).
 */
export type ConsentPolicy = 'strict_optin' | 'implicit_optin';

/**
 * Default GLOBAL atual do sistema. Re-exportado para que outros services
 * (campaigns, broadcasts, cadências) possam referenciá-lo sem hard-code.
 *
 * TODO (Sprint futuro — BUG-042): tornar configurável por conta via
 * `account.consentPolicy`. Quando essa coluna existir, callers devem
 * resolver a política da conta antes de chamar `hasConsent` e passar
 * via `options.policy`.
 */
export const CONSENT_POLICY_DEFAULT: ConsentPolicy = 'implicit_optin';

export interface HasConsentOptions {
  policy?: ConsentPolicy;
}

// ============================================
// Service
// ============================================

class WhatsappConsentService {
  // ============================================
  // normalizePhone
  // ============================================

  /**
   * Remove qualquer caractere não numérico do telefone.
   * Ex: "+55 (11) 98765-4321" → "5511987654321"
   *
   * T1-PHONE-LEN: limita tamanho de entrada e do resultado para evitar
   * que strings absurdas (ex.: 1000 digitos) propaguem por todo o stack
   * (DB upsert, webhook outbound, logger payload, etc.).
   */
  normalizePhone(phone: string): string {
    if (typeof phone !== 'string' || phone.length > 30) {
      throw new ValidationError('Telefone invalido');
    }
    const cleaned = phone.replace(/\D+/g, '');
    if (cleaned.length < 10 || cleaned.length > 15) {
      throw new ValidationError('Telefone deve ter 10-15 digitos');
    }
    return cleaned;
  }

  // ============================================
  // isOptedOut
  // ============================================

  /**
   * Retorna true se existir registro (accountId, phone) com status='opted_out'.
   */
  async isOptedOut(accountId: string, phone: string): Promise<boolean> {
    const normalized = this.normalizePhone(phone);
    if (!normalized) return false;

    const record = await prisma.whatsappConsent.findUnique({
      where: {
        accountId_phone: {
          accountId,
          phone: normalized,
        },
      },
      select: { status: true },
    });

    return record?.status === 'opted_out';
  }

  // ============================================
  // hasConsent
  // ============================================

  /**
   * Política de consent — DEFAULT: `CONSENT_POLICY_DEFAULT` ('implicit_optin').
   *
   * Comportamento por política:
   * - 'implicit_optin' (default):
   *     - Sem registro → true (consent implícito).
   *     - Com registro → true se status='opted_in', false se 'opted_out'.
   * - 'strict_optin':
   *     - Sem registro → false (exige opt-in explícito antes de qualquer disparo).
   *     - Com registro → true só se status='opted_in'.
   *
   * Justificativa do default: no fluxo atual a maior parte dos contatos vem de
   * leads inbound (formulário, inbox, conversas WhatsApp já iniciadas pelo
   * cliente), onde o consent é considerado implícito pela própria iniciativa do
   * contato. O opt-out é registrado quando o usuário pede explicitamente
   * (palavra-chave ou ação manual no CRM) e bloqueia novos disparos.
   *
   * TODO (Sprint futuro — BUG-042): tornar a política configurável por conta via
   * `account.consentPolicy` ('implicit_optin' | 'strict_optin'). Hoje a escolha
   * é feita pelo caller via `options.policy`; quando a coluna existir, o caller
   * deverá resolver a política da conta e passar aqui.
   */
  async hasConsent(
    accountId: string,
    phone: string,
    options: HasConsentOptions = {}
  ): Promise<boolean> {
    const normalized = this.normalizePhone(phone);
    if (!normalized) return false;

    const policy: ConsentPolicy = options.policy ?? CONSENT_POLICY_DEFAULT;

    const record = await prisma.whatsappConsent.findUnique({
      where: {
        accountId_phone: {
          accountId,
          phone: normalized,
        },
      },
      select: { status: true },
    });

    if (!record) {
      return policy === 'implicit_optin';
    }
    return record.status === 'opted_in';
  }

  // ============================================
  // optIn
  // ============================================

  /**
   * Upsert do registro com status='opted_in'.
   */
  async optIn(
    accountId: string,
    phone: string,
    options: ConsentOptions = {}
  ): Promise<WhatsappConsent> {
    const normalized = this.normalizePhone(phone);
    if (!normalized) {
      throw new ValidationError('Telefone inválido para opt-in');
    }

    const source = options.source ?? 'manual';

    const record = await prisma.whatsappConsent.upsert({
      where: {
        accountId_phone: {
          accountId,
          phone: normalized,
        },
      },
      create: {
        accountId,
        phone: normalized,
        status: 'opted_in',
        source,
        contactId: options.contactId ?? null,
        reason: options.reason ?? null,
      },
      update: {
        status: 'opted_in',
        source,
        contactId: options.contactId ?? null,
        reason: options.reason ?? null,
        updatedAt: new Date(),
      },
    });

    // Auditoria
    await eventService.create({
      accountId,
      eventType: 'opt.in.created',
      entityType: 'whatsapp_consent',
      entityId: record.id,
      channel: 'whatsapp',
      payload: {
        phone: normalized,
        contactId: options.contactId ?? null,
        source,
        reason: options.reason ?? null,
      },
    });

    logger.info('[whatsapp-consent] opt-in registrado', {
      accountId,
      phone: normalized,
      source,
    });

    return record;
  }

  // ============================================
  // optOut
  // ============================================

  /**
   * Upsert com status='opted_out'.
   * Emite event opt.out.created via eventService.
   * Loga intenção de webhook outbound (sem acoplar — quando worker existir, integrar aqui).
   */
  async optOut(
    accountId: string,
    phone: string,
    options: ConsentOptions = {}
  ): Promise<WhatsappConsent> {
    const normalized = this.normalizePhone(phone);
    if (!normalized) {
      throw new ValidationError('Telefone inválido para opt-out');
    }

    const source = options.source ?? 'manual';

    const record = await prisma.whatsappConsent.upsert({
      where: {
        accountId_phone: {
          accountId,
          phone: normalized,
        },
      },
      create: {
        accountId,
        phone: normalized,
        status: 'opted_out',
        source,
        contactId: options.contactId ?? null,
        reason: options.reason ?? null,
      },
      update: {
        status: 'opted_out',
        source,
        contactId: options.contactId ?? null,
        reason: options.reason ?? null,
        updatedAt: new Date(),
      },
    });

    // Auditoria (interna)
    await eventService.create({
      accountId,
      eventType: 'opt.out.created',
      entityType: 'whatsapp_consent',
      entityId: record.id,
      channel: 'whatsapp',
      payload: {
        phone: normalized,
        contactId: options.contactId ?? null,
        source,
        reason: options.reason ?? null,
      },
    });

    // BUG-006: emite webhook outbound 'optout.created' para integrações externas.
    // Fire-and-forget — o webhookOutboundService já lida com erros internamente,
    // mas envolvemos em try/catch para garantir que falha de webhook nunca derruba
    // a operação de opt-out propriamente dita.
    try {
      await webhookOutboundService.emit(accountId, 'optout.created', {
        consentId: record.id,
        phone: normalized,
        contactId: options.contactId ?? null,
        source,
        reason: options.reason ?? null,
        occurredAt: record.updatedAt.toISOString(),
      });
    } catch (err: any) {
      logger.warn('[whatsapp-consent] falha ao emitir webhook outbound optout.created', {
        accountId,
        consentId: record.id,
        error: err?.message ?? String(err),
      });
    }

    logger.info('[whatsapp-consent] opt-out registrado', {
      accountId,
      consentId: record.id,
      phone: normalized,
      source,
      reason: options.reason ?? null,
      webhookEvent: 'optout.created',
    });

    return record;
  }

  // ============================================
  // checkBatch
  // ============================================

  /**
   * Verifica em lote quais telefones de uma lista estão com `status='opted_out'`.
   *
   * Usado pelo frontend (ComplianceWarning no DispatchDialog) para alertar o
   * operador, ANTES do disparo, sobre quantos contatos do lote precisarão ser
   * removidos por conta de opt-out. Não realiza nenhum efeito colateral —
   * apenas faz lookup em massa por `(accountId, phone)`.
   *
   * Cada telefone é normalizado (somente dígitos) antes do `IN (...)`, o que
   * garante match correto independente da formatação enviada pelo cliente
   * (ex.: "+55 (11) 98765-4321" → "5511987654321"). Telefones que normalizam
   * para string vazia são descartados.
   *
   * Retorna:
   *   - `total`: tamanho do array original recebido (inclui inválidos);
   *   - `optOutCount`: quantos telefones únicos foram encontrados como opted_out;
   *   - `optedOutPhones`: lista de telefones (já normalizados) com opt-out ativo.
   */
  async checkBatch(
    accountId: string,
    phones: string[]
  ): Promise<{ total: number; optOutCount: number; optedOutPhones: string[] }> {
    const total = Array.isArray(phones) ? phones.length : 0;

    if (!accountId || total === 0) {
      return { total, optOutCount: 0, optedOutPhones: [] };
    }

    // Normaliza, remove vazios e deduplica para evitar IN (...) inflado.
    const normalizedSet = new Set<string>();
    for (const raw of phones) {
      const normalized = this.normalizePhone(String(raw ?? ''));
      if (normalized) normalizedSet.add(normalized);
    }

    if (normalizedSet.size === 0) {
      return { total, optOutCount: 0, optedOutPhones: [] };
    }

    const records = await prisma.whatsappConsent.findMany({
      where: {
        accountId,
        status: 'opted_out',
        phone: { in: Array.from(normalizedSet) },
      },
      select: { phone: true },
    });

    const optedOutPhones = records.map((r) => r.phone);

    return {
      total,
      optOutCount: optedOutPhones.length,
      optedOutPhones,
    };
  }

  // ============================================
  // listOptedOut
  // ============================================

  /**
   * Lista contatos opted_out de uma conta, com filtros opcionais de período/busca.
   */
  async listOptedOut(
    accountId: string,
    filters: ListOptedOutFilters = {}
  ): Promise<ListOptedOutResult> {
    const where: any = {
      accountId,
      status: 'opted_out',
    };

    if (filters.fromDate || filters.toDate) {
      where.updatedAt = {};
      if (filters.fromDate) where.updatedAt.gte = filters.fromDate;
      if (filters.toDate) where.updatedAt.lte = filters.toDate;
    }

    if (filters.search && filters.search.trim()) {
      const normalizedSearch = this.normalizePhone(filters.search);
      // Se a busca for puramente texto (não vira número), busca em phone como contém
      // T1-ILIKE-WILDCARD: escapa `%` e `_` para evitar wildcards SQL.
      where.phone = normalizedSearch
        ? { contains: escapeLike(normalizedSearch) }
        : { contains: escapeLike(filters.search.trim()) };
    }

    const limit = Math.min(filters.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
    const offset = Math.max(filters.offset ?? 0, 0);

    const [records, total] = await Promise.all([
      prisma.whatsappConsent.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      prisma.whatsappConsent.count({ where }),
    ]);

    // Hidrata nome do contato (best-effort)
    const contactIds = records
      .map(r => r.contactId)
      .filter((id): id is string => !!id);

    let contactNameMap = new Map<string, string | null>();
    if (contactIds.length > 0) {
      const contacts = await prisma.contact.findMany({
        where: { accountId, id: { in: contactIds } },
        select: { id: true, nome: true },
      });
      contactNameMap = new Map(contacts.map(c => [c.id, c.nome]));
    }

    const data = records.map(r => ({
      ...r,
      contactName: r.contactId ? contactNameMap.get(r.contactId) ?? null : null,
    }));

    return { data, total };
  }

  // ============================================
  // exportOptedOutCsv
  // ============================================

  /**
   * Gera CSV (string) com colunas: phone,contactName,optedOutAt,source,reason.
   *
   * BUG-043 (HIGH): `listOptedOut` aplica `MAX_LIMIT=500` silenciosamente. Aqui
   * contamos o total separadamente e, se houver truncamento, anexamos uma linha
   * de aviso ao final do CSV (em vez de remover o cap — manter o cap protege
   * o processo de OOM em contas com volume muito alto).
   *
   * BUG-044 (HIGH): CSV injection — campos como `reason` podem vir do usuário
   * final (mensagem WhatsApp em `handleInboundOptOut`). Se a célula começa com
   * `=`, `+`, `-`, `@`, `\t`, `\r` ou `\n`, planilhas (Excel/Google Sheets)
   * interpretam como fórmula. `escapeCsv` prefixa `'` nesses casos e ainda
   * faz o escape padrão de aspas/quebra de linha/vírgula.
   */
  async exportOptedOutCsv(
    accountId: string,
    filters: { fromDate?: Date; toDate?: Date } = {}
  ): Promise<string> {
    const { data, total } = await this.listOptedOut(accountId, {
      fromDate: filters.fromDate,
      toDate: filters.toDate,
      limit: MAX_LIMIT,
      offset: 0,
    });

    const header = ['phone', 'contactName', 'optedOutAt', 'source', 'reason'];
    const rows = data.map(r => [
      r.phone,
      r.contactName ?? '',
      r.updatedAt.toISOString(),
      r.source ?? '',
      r.reason ?? '',
    ]);

    const lines = [
      header.join(','),
      ...rows.map(row => row.map(v => escapeCsv(v)).join(',')),
    ];

    if (total > data.length) {
      // Linha-comentário visível em qualquer editor de texto / planilha.
      // Não usa caracteres perigosos no início, então não precisa de `escapeCsv`
      // (mas mantemos o `#` como convenção de comentário).
      lines.push(
        `# TRUNCATED at ${data.length} rows — total was ${total}. Use filters (fromDate/toDate) para reduzir o resultado.`
      );
    }

    return lines.join('\n');
  }

  // ============================================
  // handleInboundOptOut
  // ============================================

  /**
   * Detecta palavras-chave de opt-out em mensagens recebidas e, se houver match,
   * registra opt-out com source='auto_keyword'.
   * Retorna true se foi processado (match), false caso contrário.
   */
  async handleInboundOptOut(
    accountId: string,
    phone: string,
    messageText: string
  ): Promise<boolean> {
    if (!messageText || typeof messageText !== 'string') return false;

    const trimmed = messageText.trim();
    if (!trimmed) return false;

    // BUG-041: normaliza acentos antes do match para aceitar variações como
    // "cancelár", "descadastrár", "não quero mais — sair" etc.
    const sanitized = stripDiacritics(trimmed);

    // BUG-045: dois caminhos de match com critérios diferentes para reduzir
    // falsos positivos (ex.: "PARAR a aula", "vou sair do crossfit"):
    //   - PHRASE: frase específica multi-palavra → aceita em qualquer tamanho.
    //   - SINGLE-WORD: palavra isolada (sair, parar, stop, cancelar, opt-out,
    //     descadastrar) só conta se a mensagem inteira for curta (≤30 chars),
    //     intenção típica de quem está respondendo "PARAR" / "Sair" sozinho.
    const phraseMatch = OPT_OUT_PHRASE_REGEX.test(sanitized);
    const shortSingleWordMatch =
      sanitized.length <= OPT_OUT_MAX_SHORT_LEN &&
      OPT_OUT_SINGLE_WORD_REGEX.test(sanitized);

    if (!phraseMatch && !shortSingleWordMatch) {
      return false;
    }

    const normalized = this.normalizePhone(phone);
    if (!normalized) {
      logger.warn('[whatsapp-consent] inbound opt-out ignorado (telefone inválido)', {
        accountId,
        phone,
      });
      return false;
    }

    // Tenta vincular contactId pelo telefone (best-effort)
    let contactId: string | undefined;
    try {
      const contact = await prisma.contact.findFirst({
        where: { accountId, telefone: normalized },
        select: { id: true },
      });
      contactId = contact?.id;
    } catch (err: any) {
      logger.warn('[whatsapp-consent] falha ao resolver contactId para inbound opt-out', {
        accountId,
        phone: normalized,
        error: err?.message ?? String(err),
      });
    }

    await this.optOut(accountId, normalized, {
      contactId,
      source: 'auto_keyword',
      reason: `Palavra-chave recebida: "${trimmed}"`,
    });

    logger.info('[whatsapp-consent] inbound opt-out processado por keyword', {
      accountId,
      phone: normalized,
      keyword: trimmed,
    });

    return true;
  }
}

export const whatsappConsentService = new WhatsappConsentService();
