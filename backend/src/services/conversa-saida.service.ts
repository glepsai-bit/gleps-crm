/**
 * Conversa de saída: persiste no Chat (Conversation + Message) uma mensagem
 * que NÓS mandamos primeiro — disparo, prospecção, qualquer outbound que não
 * nasceu de um inbound.
 *
 * Extraído de prospecting.service (BUG-CHAT-001) para o motor de disparos
 * reaproveitar a mesma regra em vez de duplicar: o externalId é construído
 * no formato do webhook inbound ('<phone>@s.whatsapp.net'), então a resposta
 * do cliente cai na MESMA conversa via findOrCreateForCustomer.
 */
import { prisma } from '../config/database';
import { conversationService } from './conversation.service';
import { messageService } from './message.service';
import { whatsappConsentService } from './whatsapp-consent.service';
import { logger } from '../utils/logger';

export interface ContatoDeSaida {
  nome?: string | null;
  telefone: string;
}

export interface PersistirConversaDeSaidaInput {
  accountId: string;
  contato: ContatoDeSaida;
  /** UUID do inbox, ou nome dele (caminho legado de resume). */
  inboxKey: string;
  content: string;
  evolutionMsgId?: string | null;
  /**
   * 'sent' quando a Evolution aceitou; 'failed' quando devolveu erro — a
   * mensagem fica no Chat com o erro pra alguém ver e reenviar.
   */
  status?: 'sent' | 'failed';
  errorMessage?: string;
  /** Vai em metadata.source. 'dispatch' (legado) | 'disparo'. */
  origem?: string;
  /** Campos extras em metadata (ex.: disparoId). */
  metadata?: Record<string, unknown>;
}

export interface ConversaDeSaidaPersistida {
  conversationId: string;
  messageId: string;
  contactId: string | null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ConversaSaidaService {
  /**
   * Resolve o inbox (UUID → nome → primeiro ativo com Evolution), normaliza o
   * telefone no formato do webhook, cria/reusa a conversa e grava a mensagem
   * outbound (senderType='agent'). Devolve null quando não dá pra persistir
   * (sem inbox válido, telefone inválido) — o envio em si já aconteceu, e
   * perder a conversa no Chat é melhor do que derrubar o motor.
   */
  async persistir(args: PersistirConversaDeSaidaInput): Promise<ConversaDeSaidaPersistida | null> {
    const {
      accountId,
      contato,
      inboxKey,
      content,
      evolutionMsgId,
      status = 'sent',
      errorMessage,
      origem = 'dispatch',
      metadata,
    } = args;

    if (!contato?.telefone) return null;

    let inbox: { id: string } | null = null;
    if (UUID_REGEX.test(inboxKey)) {
      inbox = await prisma.inbox.findFirst({
        where: { id: inboxKey, accountId },
        select: { id: true },
      });
    }
    if (!inbox && inboxKey) {
      inbox = await prisma.inbox.findFirst({
        where: { accountId, name: inboxKey },
        select: { id: true },
      });
    }
    if (!inbox) {
      // Dispatch legado com inbox_id numérico cai aqui: melhor persistir sob
      // QUALQUER inbox válido do que perder a conversa.
      inbox = await prisma.inbox.findFirst({
        where: { accountId, active: true, evolutionInstance: { not: null } },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
    }
    if (!inbox) {
      logger.debug('[conversa-saida] sem Inbox valida para persistir conversa outbound', {
        accountId,
        inboxKey,
      });
      return null;
    }

    // Mesmo formato do webhook Evolution (só dígitos): remoteJid = '<digits>@s.whatsapp.net'.
    let normalizedPhone: string;
    try {
      normalizedPhone = whatsappConsentService.normalizePhone(contato.telefone);
    } catch {
      return null;
    }
    const externalId = `${normalizedPhone}@s.whatsapp.net`;

    // Idempotente por (accountId, inboxId, externalId): o próximo envio pro
    // mesmo contato no mesmo inbox reusa a Conversation, e o inbound também.
    const conversation = await conversationService.findOrCreateForCustomer(accountId, inbox.id, {
      externalId,
      contactPhone: normalizedPhone,
      contactName: contato.nome ?? null,
    });

    // messageService.create cuida dos contadores + first response cycle.
    const message = await messageService.create(accountId, {
      conversationId: conversation.id,
      senderType: 'agent',
      content,
      contentType: 'text',
      externalId: evolutionMsgId ?? null,
      status,
      metadata: {
        source: origem,
        ...(errorMessage ? { error: errorMessage } : {}),
        ...(metadata ?? {}),
      },
    });

    return {
      conversationId: conversation.id,
      messageId: message.id,
      contactId: conversation.contactId ?? null,
    };
  }
}

export const conversaSaidaService = new ConversaSaidaService();
