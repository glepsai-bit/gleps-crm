/**
 * Conversations Backend Service (T-022)
 *
 * Camada de acesso a /api/conversations do backend Express.
 * Cobre listagem, leitura detalhada e ciclo de vida (status, prioridade,
 * atribuição, transferência, snooze, resolve, reopen, labels, participants,
 * custom attributes e markAsRead).
 *
 * Padrão: apiClient + API_ENDPOINTS.CONVERSATIONS. Sem mapeamento agressivo —
 * o backend já retorna camelCase via Prisma. Helpers `unwrap*` normalizam o
 * envelope `{ data, total? }` usado pelos controllers.
 */

import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// ============================================
// Tipos públicos
// ============================================

export type ConversationStatus = 'open' | 'pending' | 'resolved' | 'snoozed';
export type ConversationPriority = 'urgent' | 'high' | 'medium' | 'low';
export type ConversationResolvedBy = 'ai' | 'human' | 'timeout';

export type MessageContentType =
  | 'text'
  | 'media'
  | 'audio'
  | 'document'
  | 'system_note'
  | 'template';

export type MessageSenderType =
  | 'customer'
  | 'agent'
  | 'ai_bot'
  | 'system'
  | 'integration';

export type AttachmentFileType = 'image' | 'video' | 'audio' | 'document';

export interface Attachment {
  id: string;
  messageId: string;
  fileType: AttachmentFileType;
  fileUrl: string;
  fileSize?: number | null;
  fileName?: string | null;
  mimeType?: string | null;
  thumbnailUrl?: string | null;
  duration?: number | null;
  createdAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  senderType: MessageSenderType;
  senderId: string | null;
  content: string | null;
  contentType: MessageContentType;
  isPrivate: boolean;
  status: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  externalId: string | null;
  replyToId: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  attachments?: Attachment[];
}

export interface ConversationContactSummary {
  id: string;
  nome: string | null;
  telefone: string | null;
  email: string | null;
}

export interface ConversationInboxSummary {
  id: string;
  name: string;
  channelType: string;
}

export interface ConversationUserSummary {
  id: string;
  nome: string | null;
  email: string;
}

export interface ConversationTeamSummary {
  id: string;
  name: string;
}

export interface ConversationLabel {
  id: string;
  conversationId: string;
  tagId: string;
  createdAt: string;
  tag?: {
    id: string;
    name: string;
    color: string;
    slug?: string;
  };
}

export interface ConversationParticipant {
  id: string;
  conversationId: string;
  userId: string;
  createdAt: string;
  user?: ConversationUserSummary;
}

export interface Conversation {
  id: string;
  accountId: string;
  inboxId: string;
  contactId: string | null;
  status: ConversationStatus;
  priority: ConversationPriority;
  assigneeId: string | null;
  teamId: string | null;
  slaPolicyId: string | null;
  snoozedUntil: string | null;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  resolvedBy: ConversationResolvedBy | null;
  externalId: string | null;
  customAttributes: Record<string, unknown> | null;
  unreadCount: number;
  createdAt: string;
  updatedAt: string;
  // Relações incluídas conforme `include` e listagem default
  contact?: ConversationContactSummary | null;
  inbox?: ConversationInboxSummary;
  assignee?: ConversationUserSummary | null;
  team?: ConversationTeamSummary | null;
  messages?: Message[];
  labels?: ConversationLabel[];
  participants?: ConversationParticipant[];
}

// ============================================
// Filtros / inputs
// ============================================

export interface ListConversationsFilters {
  status?: ConversationStatus;
  /** Use string 'null' (ou null) para filtrar "não atribuído". */
  assigneeId?: string | null;
  /** Use string 'null' (ou null) para filtrar "sem time". */
  teamId?: string | null;
  inboxId?: string;
  labelId?: string;
  priority?: ConversationPriority;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface GetConversationIncludeOptions {
  messages?: boolean;
  participants?: boolean;
  labels?: boolean;
}

export interface CreateConversationInput {
  inboxId: string;
  contactId?: string | null;
  externalId?: string | null;
  priority?: ConversationPriority;
  customAttributes?: Record<string, unknown>;
}

export interface TransferConversationInput {
  to: 'agent' | 'team';
  targetId: string | null;
  note?: string;
}

export interface ResolveConversationInput {
  resolvedBy: ConversationResolvedBy;
}

// ============================================
// Helpers de envelope
// ============================================

interface DataEnvelope<T> {
  data: T;
}

interface ListEnvelope<T> {
  data: T[];
  total: number;
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

function unwrapList<T>(
  payload: T[] | ListEnvelope<T> | DataEnvelope<T[]>
): { data: T[]; total: number } {
  if (Array.isArray(payload)) {
    return { data: payload, total: payload.length };
  }
  const obj = payload as ListEnvelope<T> | DataEnvelope<T[]>;
  const data = Array.isArray(obj.data) ? obj.data : [];
  const total = typeof (obj as ListEnvelope<T>).total === 'number'
    ? (obj as ListEnvelope<T>).total
    : data.length;
  return { data, total };
}

function buildIncludeParam(
  include?: GetConversationIncludeOptions
): Record<string, string> | undefined {
  if (!include) return undefined;
  const parts: string[] = [];
  if (include.messages) parts.push('messages');
  if (include.participants) parts.push('participants');
  if (include.labels) parts.push('labels');
  if (parts.length === 0) return undefined;
  return { include: parts.join(',') };
}

// ============================================
// Service
// ============================================

export const conversationsBackendService = {
  /**
   * GET /api/conversations
   */
  async listConversations(
    filters: ListConversationsFilters = {}
  ): Promise<{ data: Conversation[]; total: number }> {
    const params: Record<string, string | number | boolean> = {};

    if (filters.status) params.status = filters.status;
    if (filters.priority) params.priority = filters.priority;
    if (filters.inboxId) params.inboxId = filters.inboxId;
    if (filters.labelId) params.labelId = filters.labelId;
    if (filters.search) params.search = filters.search;
    if (typeof filters.limit === 'number') params.limit = filters.limit;
    if (typeof filters.offset === 'number') params.offset = filters.offset;

    // assigneeId / teamId: undefined = sem filtro; null ou 'null' = não atribuído
    if (filters.assigneeId !== undefined) {
      params.assigneeId = filters.assigneeId === null ? 'null' : filters.assigneeId;
    }
    if (filters.teamId !== undefined) {
      params.teamId = filters.teamId === null ? 'null' : filters.teamId;
    }

    const response = await apiClient.get<
      ListEnvelope<Conversation> | Conversation[]
    >(API_ENDPOINTS.CONVERSATIONS.LIST, { params });

    return unwrapList<Conversation>(response);
  },

  /**
   * GET /api/conversations/:id
   */
  async getConversation(
    id: string,
    include?: GetConversationIncludeOptions
  ): Promise<Conversation> {
    const response = await apiClient.get<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.GET(id),
      { params: buildIncludeParam(include) }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations
   */
  async createConversation(body: CreateConversationInput): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.CREATE,
      body
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * PATCH /api/conversations/:id/status
   */
  async updateConversationStatus(
    id: string,
    status: ConversationStatus
  ): Promise<Conversation> {
    const response = await apiClient.patch<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.UPDATE_STATUS(id),
      { status }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * PATCH /api/conversations/:id/priority
   */
  async updatePriority(
    id: string,
    priority: ConversationPriority
  ): Promise<Conversation> {
    const response = await apiClient.patch<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.UPDATE_PRIORITY(id),
      { priority }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/assign
   * Passe `null` para desatribuir.
   */
  async assignConversation(
    id: string,
    assigneeId: string | null
  ): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.ASSIGN(id),
      { assigneeId }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/assign-team
   * Passe `null` para remover do time.
   */
  async assignTeam(id: string, teamId: string | null): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.ASSIGN_TEAM(id),
      { teamId }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/transfer
   */
  async transferConversation(
    id: string,
    body: TransferConversationInput
  ): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.TRANSFER(id),
      body
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/snooze
   * `until` em Date ou ISO string.
   */
  async snoozeConversation(id: string, until: Date | string): Promise<Conversation> {
    const isoUntil = until instanceof Date ? until.toISOString() : until;
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.SNOOZE(id),
      { until: isoUntil }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/resolve
   * `resolvedBy`: 'ai' | 'human' | 'timeout'. O parâmetro adicional do
   * orquestrador (`resolvedBy`) é o mesmo do payload — userId vem do JWT no
   * backend, não precisa ser enviado.
   */
  async resolveConversation(
    id: string,
    body: ResolveConversationInput
  ): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.RESOLVE(id),
      { resolvedBy: body.resolvedBy }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/reopen
   */
  async reopenConversation(id: string): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.REOPEN(id)
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/labels
   */
  async addLabel(id: string, tagId: string): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.ADD_LABEL(id),
      { tagId }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * DELETE /api/conversations/:id/labels/:tagId
   */
  async removeLabel(id: string, tagId: string): Promise<Conversation> {
    const response = await apiClient.delete<
      DataEnvelope<Conversation> | Conversation
    >(API_ENDPOINTS.CONVERSATIONS.REMOVE_LABEL(id, tagId));
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/participants
   */
  async addParticipant(id: string, userId: string): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.ADD_PARTICIPANT(id),
      { userId }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * DELETE /api/conversations/:id/participants/:userId
   */
  async removeParticipant(id: string, userId: string): Promise<Conversation> {
    const response = await apiClient.delete<
      DataEnvelope<Conversation> | Conversation
    >(API_ENDPOINTS.CONVERSATIONS.REMOVE_PARTICIPANT(id, userId));
    return unwrapData<Conversation>(response);
  },

  /**
   * PATCH /api/conversations/:id/custom-attributes
   */
  async setCustomAttributes(
    id: string,
    attrs: Record<string, unknown>
  ): Promise<Conversation> {
    const response = await apiClient.patch<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.CUSTOM_ATTRIBUTES(id),
      { attrs }
    );
    return unwrapData<Conversation>(response);
  },

  /**
   * POST /api/conversations/:id/read
   */
  async markAsRead(id: string): Promise<Conversation> {
    const response = await apiClient.post<DataEnvelope<Conversation> | Conversation>(
      API_ENDPOINTS.CONVERSATIONS.MARK_READ(id)
    );
    return unwrapData<Conversation>(response);
  },
};

export default conversationsBackendService;
