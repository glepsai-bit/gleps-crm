import type { WhatsappConsent } from '@prisma/client';
import { prisma } from '../config/database';
import { eventService } from './event.service';
import { webhookOutboundService } from './webhook-outbound.service';
import { ValidationError } from '../utils/errors';
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

// BUG-006: regex relaxada — aceita palavra-chave em qualquer posição da mensagem
// e cobre mais variantes (descadastrar, remover, opt-out / opt_out / optout).
const OPT_OUT_KEYWORD_REGEX = /\b(sair|parar|stop|cancelar|opt[\s\-_]?out|descadastrar|remover)\b/i;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

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
   */
  normalizePhone(phone: string): string {
    if (!phone) return '';
    return String(phone).replace(/\D+/g, '');
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
   * Regra inicial: opt-in é default. Só não tem consent quem fez opt-out explícito.
   * → true se NÃO existe registro OU registro tem status='opted_in'.
   */
  async hasConsent(accountId: string, phone: string): Promise<boolean> {
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

    if (!record) return true;
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
      where.phone = normalizedSearch
        ? { contains: normalizedSearch }
        : { contains: filters.search.trim() };
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
   */
  async exportOptedOutCsv(
    accountId: string,
    filters: { fromDate?: Date; toDate?: Date } = {}
  ): Promise<string> {
    const { data } = await this.listOptedOut(accountId, {
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

    const escape = (value: string): string => {
      const str = String(value ?? '');
      if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    const lines = [
      header.join(','),
      ...rows.map(row => row.map(escape).join(',')),
    ];

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

    if (!OPT_OUT_KEYWORD_REGEX.test(trimmed)) {
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
