/**
 * Socket.IO Client — T-022 Sprint 4 (chat interno em tempo real)
 *
 * Singleton fino em volta do `socket.io-client` que conversa com o namespace
 * `/chat` do backend Express (ver backend/src/socket/index.ts).
 *
 * Eventos emitidos pelo backend (assinaturas):
 *   - 'message:created'          → { conversationId, message }
 *   - 'message:updated'          → { conversationId, message }
 *   - 'message:reaction:updated' → { conversationId, messageId, reactions }
 *   - 'conversation:updated'     → { conversationId, conversation }
 *   - 'conversation:assigned'    → { conversationId, assignee }
 *   - 'mention:new'              → MentionPayload
 *   - 'agent:status'             → { userId, status }
 *   - 'typing'                   → { conversationId, userId, isTyping }
 *
 * Eventos consumidos pelo backend (cliente → servidor):
 *   - 'join-conversation'      → conversationId | { conversationId }
 *   - 'leave-conversation'     → conversationId | { conversationId }
 *   - 'typing'                 → { conversationId, isTyping }
 *   - 'heartbeat'              → (vazio)
 *
 * Autenticação: JWT (mesmo do REST) via `handshake.auth.token`.
 *
 * URL: usa `VITE_API_URL` quando definido (produção/staging) e cai para a
 * origem da página em dev (Vite proxy). O namespace `/chat` é fixo.
 */

import { io, type Socket } from 'socket.io-client';

// ============================================
// Types — payloads emitidos pelo backend
// ============================================

export type AgentStatus = 'online' | 'away' | 'busy' | 'offline';

export interface MessageCreatedPayload {
  conversationId: string;
  message: unknown;
}

/**
 * CHAT-REPLY-EDIT-DEL: emitido pelo backend quando uma mensagem existente
 * é editada (metadata.edited=true, novo content) ou soft-deleted
 * (content=null, deletedAt preenchido). Mesmo shape do created.
 */
export interface MessageUpdatedPayload {
  conversationId: string;
  message: unknown;
}

/**
 * CHAT-REACTIONS FURO 2: emitido pelo backend após addReaction /
 * removeReaction / recordCustomerReaction. `reactions` é o mesmo aggregate
 * agrupado por emoji retornado por list()/get(): `{ emoji, count, userIds,
 * externalContactIds }[]`. O caller aplica PATCH direto na msg do cache
 * do thread — sem refetch, sem F5.
 */
export interface MessageReactionUpdatedPayload {
  conversationId: string;
  messageId: string;
  reactions: unknown;
}

export interface ConversationUpdatedPayload {
  conversationId: string;
  conversation: unknown;
}

export interface ConversationAssignedPayload {
  conversationId: string;
  assignee: unknown;
}

export interface MentionPayload {
  id: string;
  conversationId: string;
  messageId?: string | null;
  fromUserId?: string | null;
  read?: boolean;
  createdAt?: string;
}

export interface AgentStatusPayload {
  userId: string;
  status: AgentStatus;
}

export interface TypingPayload {
  conversationId: string;
  userId: string;
  isTyping: boolean;
}

type Listener<T> = (payload: T) => void;
type Unsubscribe = () => void;

// ============================================
// URL resolution
// ============================================

/**
 * Resolve a URL base do Socket.IO.
 *
 *  - Em dev (sem VITE_API_URL): usa a origin da página (window.location.origin)
 *    e o Vite proxy mapeia /socket.io → backend.
 *  - Em produção/staging: respeita VITE_API_URL. Se for caminho relativo
 *    (ex.: "/api"), volta a usar a origin.
 *  - Caso especial: se a env vier com `/api` no final, removemos — o socket
 *    não passa pelo prefixo do REST.
 */
function resolveSocketBaseUrl(): string {
  const meta = import.meta as ImportMeta & {
    env?: Record<string, string | undefined>;
  };
  const envUrl = meta.env?.VITE_API_URL ?? meta.env?.VITE_API_URL_STAGING ?? '';

  let base: string;
  if (typeof envUrl === 'string' && envUrl.trim() && envUrl.startsWith('http')) {
    base = envUrl.trim();
  } else if (typeof window !== 'undefined' && window.location?.origin) {
    base = window.location.origin;
  } else {
    base = 'http://localhost:3000';
  }

  // Tira trailing slash e um sufixo "/api" se vier acoplado.
  base = base.replace(/\/+$/, '');
  if (base.endsWith('/api')) {
    base = base.slice(0, -'/api'.length);
  }
  return base;
}

// ============================================
// ChatSocket — wrapper singleton
// ============================================

export class ChatSocket {
  private socket: Socket | null = null;
  private currentToken: string | null = null;

  /**
   * FIX-REALTIME-REJOIN: as salas de conversa são por-conexão no servidor e se
   * perdem em CADA reconnect (deploy do backend, restart, blip de rede). Sem
   * re-entrar, a thread aberta parava de receber `message:created` — a mensagem
   * aparecia só na lista (poll 30s) e no chat só no poll de 60s. Rastreamos aqui
   * as conversas em que o app quer estar e re-emitimos join no evento 'connect'.
   */
  private joinedConversations = new Set<string>();

  /**
   * H-DASH-3: buffer de listeners que tentaram se registrar ANTES do
   * connect(). Em React, é comum que uma página filha do AdminLayout monte
   * e dispare seu useEffect (subscribe) antes do useEffect do layout pai
   * chegar a chamar connect(). Sem o buffer o subscribe virava no-op e a
   * UI nunca recebia eventos realtime (live-attendance ficava "congelado"
   * dependendo só do refetchInterval).
   *
   * Quando connect() roda, os pendentes são "flushados" no socket recém
   * criado. Cleanup retornado pelo subscribe() continua funcionando tanto
   * pra listener buffered quanto pra listener já anexado.
   */
  private pendingSubscriptions: Array<{
    event: string;
    cb: (...args: unknown[]) => void;
    attached: boolean;
  }> = [];

  /**
   * Conecta no namespace `/chat` com o JWT. Idempotente: se já estiver
   * conectado com o mesmo token, retorna o socket existente; se mudar o
   * token (refresh / re-login), reconecta.
   */
  connect(token: string): Socket {
    if (!token) {
      throw new Error('[chatSocket] token JWT é obrigatório para conectar');
    }

    if (this.socket && this.currentToken === token) {
      if (!this.socket.connected) this.socket.connect();
      return this.socket;
    }

    // Token diferente → derruba a conexão antiga antes de abrir nova.
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
      // Listeners anexados ao socket antigo precisam ser re-anexados ao novo.
      for (const sub of this.pendingSubscriptions) {
        sub.attached = false;
      }
    }

    const baseUrl = resolveSocketBaseUrl();
    const url = `${baseUrl}/chat`;

    this.currentToken = token;
    this.socket = io(url, {
      transports: ['websocket', 'polling'],
      auth: { token },
      // O backend valida JWT no handshake; o reconnect default é suficiente.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
      withCredentials: true,
    });

    // FIX-REALTIME-REJOIN: dispara no connect inicial E em cada reconnect
    // (socket.io emite 'connect' nas duas situações). Re-entra em todas as
    // salas de conversa ativas — de outro modo, após um rebuild do backend o
    // cliente ficava fora da sala e a thread aberta não recebia mais mensagem
    // em tempo real (só via polling). join no servidor é idempotente.
    this.socket.on('connect', () => {
      for (const id of this.joinedConversations) {
        this.socket?.emit('join-conversation', { conversationId: id });
      }
    });

    // Flush dos listeners que tentaram subscribe antes do connect.
    this.flushPendingSubscriptions();

    return this.socket;
  }

  /** Anexa todos os pendentes ao socket atual. */
  private flushPendingSubscriptions(): void {
    if (!this.socket) return;
    for (const sub of this.pendingSubscriptions) {
      if (!sub.attached) {
        this.socket.on(sub.event, sub.cb);
        sub.attached = true;
      }
    }
  }

  /** Encerra a conexão e limpa listeners. */
  disconnect(): void {
    if (!this.socket) return;
    this.socket.removeAllListeners();
    this.socket.disconnect();
    this.socket = null;
    this.currentToken = null;
    // Mantém pendingSubscriptions como "desconectadas" — se connect() for
    // chamado de novo (re-login), reanexamos. O caller é quem decide se
    // limpa via cleanup retornado pelo subscribe().
    for (const sub of this.pendingSubscriptions) {
      sub.attached = false;
    }
  }

  /** Indica se a conexão está aberta. */
  isConnected(): boolean {
    return Boolean(this.socket?.connected);
  }

  /** Retorna o socket cru (para casos avançados). */
  getSocket(): Socket | null {
    return this.socket;
  }

  // ------------------------------------------
  // Rooms / conversas
  // ------------------------------------------

  /** Entra na sala de uma conversa (passa a receber 'message:created' dela). */
  joinConversation(conversationId: string): void {
    if (!conversationId) return;
    this.joinedConversations.add(conversationId);
    this.socket?.emit('join-conversation', { conversationId });
  }

  /** Sai da sala da conversa. */
  leaveConversation(conversationId: string): void {
    if (!conversationId) return;
    this.joinedConversations.delete(conversationId);
    this.socket?.emit('leave-conversation', { conversationId });
  }

  /** Avisa que o usuário está (ou parou de) digitando numa conversa. */
  sendTyping(conversationId: string, isTyping: boolean): void {
    if (!conversationId) return;
    this.socket?.emit('typing', {
      conversationId,
      isTyping: Boolean(isTyping),
    });
  }

  /** Heartbeat manual (o servidor também mantém presença via ping/pong). */
  sendHeartbeat(): void {
    this.socket?.emit('heartbeat');
  }

  // ------------------------------------------
  // Subscribers
  //
  // Retornam uma função de "unsubscribe" — padrão React (useEffect cleanup).
  // ------------------------------------------

  onMessageCreated(cb: Listener<MessageCreatedPayload>): Unsubscribe {
    return this.subscribe('message:created', cb);
  }

  /**
   * CHAT-REPLY-EDIT-DEL: assina mutações em mensagem existente (edit ou
   * soft delete). O caller aplica PATCH direto no cache do thread.
   */
  onMessageUpdated(cb: Listener<MessageUpdatedPayload>): Unsubscribe {
    return this.subscribe('message:updated', cb);
  }

  /**
   * CHAT-REACTIONS FURO 2: assina atualizações de reactions de uma
   * mensagem (add/remove por agente ou cliente WhatsApp via webhook).
   * Payload traz o aggregate já agrupado por emoji — o caller apenas
   * substitui `msg.reactions` no cache do thread.
   */
  onMessageReactionUpdated(
    cb: Listener<MessageReactionUpdatedPayload>
  ): Unsubscribe {
    return this.subscribe('message:reaction:updated', cb);
  }

  onConversationUpdated(cb: Listener<ConversationUpdatedPayload>): Unsubscribe {
    return this.subscribe('conversation:updated', cb);
  }

  onAssigned(cb: Listener<ConversationAssignedPayload>): Unsubscribe {
    return this.subscribe('conversation:assigned', cb);
  }

  onMention(cb: Listener<MentionPayload>): Unsubscribe {
    return this.subscribe('mention:new', cb);
  }

  onAgentStatusChanged(cb: Listener<AgentStatusPayload>): Unsubscribe {
    return this.subscribe('agent:status', cb);
  }

  onTyping(cb: Listener<TypingPayload>): Unsubscribe {
    return this.subscribe('typing', cb);
  }

  // ------------------------------------------
  // Internals
  // ------------------------------------------

  private subscribe<T>(event: string, cb: Listener<T>): Unsubscribe {
    if (!this.socket) {
      // AUDIT-H-DASH-3: antes este ramo era um no-op com console.warn — o
      // buffer pendingSubscriptions existia mas NUNCA era populado, então
      // efeitos filhos que montavam antes do connect() do layout pai perdiam
      // o listener para sempre (live-attendance congelado, só polling).
      // Agora enfileiramos de verdade; flushPendingSubscriptions() anexa no
      // connect() e o unsubscribe cobre os dois estados (buffered/anexado).
      const entry = {
        event,
        cb: cb as (...args: unknown[]) => void,
        attached: false,
      };
      this.pendingSubscriptions.push(entry);
      return () => {
        const idx = this.pendingSubscriptions.indexOf(entry);
        if (idx >= 0) this.pendingSubscriptions.splice(idx, 1);
        if (entry.attached && this.socket) {
          this.socket.off(entry.event, entry.cb);
        }
      };
    }
    const socket = this.socket;
    socket.on(event, cb as (...args: unknown[]) => void);
    return () => {
      socket.off(event, cb as (...args: unknown[]) => void);
    };
  }
}

/** Instância singleton compartilhada — importe e use direto. */
export const chatSocket = new ChatSocket();

export default chatSocket;
