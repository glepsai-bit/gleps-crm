/**
 * Messages Backend Service (T-022)
 *
 * Camada de acesso aos endpoints de mensagens do chat (T-022):
 *   GET    /api/conversations/:id/messages
 *   POST   /api/conversations/:id/messages
 *   POST   /api/messages/:id/read
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
};

export default messagesBackendService;
