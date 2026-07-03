/**
 * Messages Backend Service (T-022)
 *
 * Camada de acesso aos endpoints de mensagens do chat (T-022):
 *   GET    /api/conversations/:id/messages
 *   POST   /api/conversations/:id/messages
 *   POST   /api/messages/:id/read
 *   PATCH  /api/messages/:id                    — CHAT-REPLY-EDIT-DEL (edit)
 *   DELETE /api/messages/:id                    — CHAT-REPLY-EDIT-DEL (soft delete)
 *   GET    /api/messages/:id/reactions          — CHAT-REACTIONS (list)
 *   POST   /api/messages/:id/reactions          — CHAT-REACTIONS (add)
 *   DELETE /api/messages/:id/reactions/:emoji   — CHAT-REACTIONS (remove)
 *   GET    /api/messages/search
 *
 * Reaproveita os tipos `Message` / `Attachment` exportados pelo
 * conversations.backend.service para manter uma única fonte de verdade.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import type {
  Attachment,
  AttachmentFileType,
  Message,
  MessageContentType,
} from './conversations.backend.service';

// Re-export para consumidores que importam tudo de messages.backend.service
export type { Attachment, AttachmentFileType, Message, MessageContentType };

// ============================================
// CHAT-REACTIONS — tipos de reaction
// ============================================

/**
 * Row bruta do backend GET /api/messages/:id/reactions.
 * `userId=null` + `externalContactId != null` = reaction do cliente WhatsApp.
 * `userId != null` = reaction de agente humano interno.
 */
export interface MessageReactionRow {
  id: string;
  messageId: string;
  userId: string | null;
  externalContactId?: string | null;
  emoji: string;
  createdAt: string;
  user?: { id: string; nome: string | null; email: string } | null;
}

/**
 * Aggregate exibido na UI (um pill por emoji). `byMe=true` quando o
 * usuário atual reagiu com esse emoji — usado para toggle (POST se
 * false, DELETE se true).
 */
export interface MessageReactionAggregate {
  emoji: string;
  count: number;
  userIds: string[];
  externalContactIds: string[];
  byMe: boolean;
}

/**
 * Reduz o array plano do backend em pills agregados por emoji.
 * `currentUserId` habilita `byMe` — deve ser o `user.id` autenticado.
 */
export function aggregateReactions(
  rows: MessageReactionRow[],
  currentUserId: string | null | undefined
): MessageReactionAggregate[] {
  const byEmoji = new Map<string, MessageReactionAggregate>();
  for (const r of rows) {
    const existing = byEmoji.get(r.emoji) ?? {
      emoji: r.emoji,
      count: 0,
      userIds: [],
      externalContactIds: [],
      byMe: false,
    };
    existing.count += 1;
    if (r.userId) {
      existing.userIds.push(r.userId);
      if (currentUserId && r.userId === currentUserId) {
        existing.byMe = true;
      }
    } else if (r.externalContactId) {
      existing.externalContactIds.push(r.externalContactId);
    }
    byEmoji.set(r.emoji, existing);
  }
  return Array.from(byEmoji.values());
}

// ============================================
// MENTIONS — histórico do sino
// ============================================

export interface MentionRow {
  id: string;
  conversationId: string;
  userId: string;
  messageId?: string | null;
  fromUserId?: string | null;
  read: boolean;
  createdAt: string;
  conversation?: {
    id: string;
    contact?: {
      id: string;
      nome: string | null;
      telefone: string | null;
    } | null;
  } | null;
}

export interface ListMentionsFilters {
  limit?: number;
  read?: 'true' | 'false' | 'all';
}

// ============================================
// Inputs / filtros
// ============================================

export interface ListMessagesFilters {
  limit?: number;
  /** ISO 8601 — retorna mensagens criadas antes desse timestamp (paginação reversa). */
  before?: string;
  /** ISO 8601 — retorna mensagens criadas depois desse timestamp. */
  after?: string;
}

export interface SendAttachmentInput {
  fileType: AttachmentFileType;
  fileUrl: string;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
  thumbnailUrl?: string;
  duration?: number;
}

export interface SendMessageInput {
  content?: string;
  contentType?: MessageContentType;
  isPrivate?: boolean;
  replyToId?: string;
  attachments?: SendAttachmentInput[];
  metadata?: Record<string, unknown>;
}

export interface SearchMessagesFilters {
  limit?: number;
}

// ============================================
// Envelope helpers
// ============================================

interface DataEnvelope<T> {
  data: T;
}

function unwrapData<T>(payload: T | DataEnvelope<T>): T {
  if (
    payload !== null &&
    typeof payload === 'object' &&
    'data' in (payload as Record<string, unknown>)
  ) {
    return (payload as DataEnvelope<T>).data;
  }
  return payload as T;
}

function unwrapArray<T>(payload: T[] | DataEnvelope<T[]>): T[] {
  if (Array.isArray(payload)) return payload;
  const data = (payload as DataEnvelope<T[]>)?.data;
  return Array.isArray(data) ? data : [];
}

// ============================================
// Service
// ============================================

export const messagesBackendService = {
  /**
   * GET /api/conversations/:conversationId/messages
   */
  async listMessages(
    conversationId: string,
    filters: ListMessagesFilters = {}
  ): Promise<Message[]> {
    const params: Record<string, string | number> = {};
    if (typeof filters.limit === 'number') params.limit = filters.limit;
    if (filters.before) params.before = filters.before;
    if (filters.after) params.after = filters.after;

    const response = await apiClient.get<Message[] | DataEnvelope<Message[]>>(
      API_ENDPOINTS.MESSAGES.LIST(conversationId),
      { params }
    );
    return unwrapArray<Message>(response);
  },

  /**
   * POST /api/conversations/:conversationId/messages
   *
   * O backend valida que pelo menos `content` ou `attachments[]` esteja
   * presente. Notas internas viajam com `isPrivate: true`.
   */
  async sendMessage(
    conversationId: string,
    body: SendMessageInput
  ): Promise<Message> {
    const response = await apiClient.post<Message | DataEnvelope<Message>>(
      API_ENDPOINTS.MESSAGES.SEND(conversationId),
      body
    );
    return unwrapData<Message>(response);
  },

  /**
   * POST /api/messages/:id/read
   */
  async markMessageRead(id: string): Promise<Message> {
    const response = await apiClient.post<Message | DataEnvelope<Message>>(
      API_ENDPOINTS.MESSAGES.MARK_READ(id)
    );
    return unwrapData<Message>(response);
  },

  /**
   * GET /api/messages/search?q=...&limit=...
   * `q` exige no mínimo 2 caracteres (validado no backend).
   */
  async searchMessages(
    q: string,
    filters: SearchMessagesFilters = {}
  ): Promise<Message[]> {
    const params: Record<string, string | number> = { q };
    if (typeof filters.limit === 'number') params.limit = filters.limit;

    const response = await apiClient.get<Message[] | DataEnvelope<Message[]>>(
      API_ENDPOINTS.MESSAGES.SEARCH,
      { params }
    );
    return unwrapArray<Message>(response);
  },

  // ============================================
  // CHAT-REPLY-EDIT-DEL — edit + soft delete outbound
  // ============================================

  /**
   * PATCH /api/messages/:id
   *
   * Edita conteúdo de uma mensagem outbound do próprio agente
   * (janela: 15 min após envio). Backend valida ownership + janela.
   */
  async editMessage(id: string, content: string): Promise<Message> {
    const response = await apiClient.patch<Message | DataEnvelope<Message>>(
      API_ENDPOINTS.MESSAGES.UPDATE(id),
      { content }
    );
    return unwrapData<Message>(response);
  },

  /**
   * DELETE /api/messages/:id
   *
   * Soft delete: backend zera `content` e preenche `deletedAt=now()`.
   * Propaga delete-for-everyone pro WhatsApp (best-effort).
   * Retorna a mensagem já com deletedAt preenchido — a UI usa isso pra
   * substituir o cache local antes de qualquer refetch.
   */
  async deleteMessage(id: string): Promise<Message> {
    const response = await apiClient.delete<Message | DataEnvelope<Message>>(
      API_ENDPOINTS.MESSAGES.DELETE(id)
    );
    return unwrapData<Message>(response);
  },

  // ============================================
  // CHAT-REACTIONS
  // ============================================

  /**
   * GET /api/messages/:id/reactions
   * Lista reactions (flat). O caller normalmente passa por
   * `aggregateReactions()` pra gerar os pills.
   */
  async listReactions(id: string): Promise<MessageReactionRow[]> {
    const response = await apiClient.get<
      MessageReactionRow[] | DataEnvelope<MessageReactionRow[]>
    >(API_ENDPOINTS.MESSAGES.REACTIONS(id));
    return unwrapArray<MessageReactionRow>(response);
  },

  /**
   * POST /api/messages/:id/reactions {emoji}
   *
   * Idempotente por (msgId, userId, emoji). Backend também propaga o
   * emoji pro WhatsApp via Evolution (best-effort).
   */
  async reactMessage(id: string, emoji: string): Promise<MessageReactionRow> {
    const response = await apiClient.post<
      MessageReactionRow | DataEnvelope<MessageReactionRow>
    >(API_ENDPOINTS.MESSAGES.REACTIONS(id), { emoji });
    return unwrapData<MessageReactionRow>(response);
  },

  /**
   * DELETE /api/messages/:id/reactions/:emoji
   *
   * Remove a reaction do usuário atual (com aquele emoji). Backend
   * também propaga "reaction vazia" pro WhatsApp (unreact).
   */
  async removeReaction(
    id: string,
    emoji: string
  ): Promise<{ removed: boolean }> {
    const response = await apiClient.delete<
      { removed: boolean } | DataEnvelope<{ removed: boolean }>
    >(API_ENDPOINTS.MESSAGES.REACTION_REMOVE(id, emoji));
    return unwrapData<{ removed: boolean }>(response);
  },

  // ============================================
  // MENTIONS — histórico do sino
  // ============================================

  /**
   * GET /api/mentions?limit=&read=false|true|all
   *
   * Retorna as mentions do usuário autenticado dentro da conta ativa.
   * Default do backend: apenas não-lidas (`read=false`), ordenadas por
   * `createdAt desc`, limit=20. Include: `conversation.contact.nome`.
   */
  async getMentions(
    filters: ListMentionsFilters = {}
  ): Promise<MentionRow[]> {
    const params: Record<string, string | number> = {};
    if (typeof filters.limit === 'number') params.limit = filters.limit;
    if (filters.read) params.read = filters.read;

    const response = await apiClient.get<MentionRow[] | DataEnvelope<MentionRow[]>>(
      API_ENDPOINTS.MENTIONS.LIST,
      { params }
    );
    return unwrapArray<MentionRow>(response);
  },

  /**
   * PATCH /api/mentions/:id/read
   * Marca mention como lida (não bloqueante — best-effort).
   */
  async markMentionRead(id: string): Promise<{ updated: number }> {
    const response = await apiClient.patch<
      { updated: number } | DataEnvelope<{ updated: number }>
    >(API_ENDPOINTS.MENTIONS.MARK_READ(id));
    return unwrapData<{ updated: number }>(response);
  },
};

export default messagesBackendService;
