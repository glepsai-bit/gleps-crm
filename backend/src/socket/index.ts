/**
 * SOCKET.IO SERVER — T-022 Sprint 4 (Chat interno em tempo real)
 *
 * Encapsula a inicialização e os helpers de emissão do Socket.IO usados por:
 *  - frontend (chat interno multi-tenant: salas de conversa, presença, typing)
 *  - services do backend (broadcast de mensagens, mudanças de conversa,
 *    menções e mudança de status de agentes).
 *
 * Convenções:
 *  - Namespace fixo: '/chat'.
 *  - Rooms:
 *      account:${accountId}                       → broadcasts da conta inteira
 *      account:${accountId}:conv:${conversationId} → eventos de uma conversa
 *      account:${accountId}:user:${userId}        → eventos diretos pro usuário
 *  - Autenticação: JWT (mesmo token do REST) via handshake.auth.token ou
 *    Authorization: Bearer <token> no header. O middleware popula `socket.data`
 *    com { userId, accountId, role }.
 *  - Multi-tenancy: toda emissão é roteada por accountId; é proibido emitir
 *    pra outra conta.
 *
 * O singleton `io` (namespace /chat) é guardado em módulo e exposto via
 * `getIO()` pra que services possam emitir sem importar o server.
 */

import type { Server as HttpServer } from 'http';
import { Server as SocketIOServer, Namespace, Socket } from 'socket.io';
import jwt from 'jsonwebtoken';
import { env, isDevelopment } from '../config/env';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { agentAvailabilityService } from '../services/agent-availability.service';
import type { JwtPayload } from '../types';

// ============================================
// Types
// ============================================

export interface SocketAuthData {
  userId: string;
  accountId: string | null;
  role: string;
}

export interface MentionPayload {
  id: string;
  conversationId: string;
  messageId?: string | null;
  fromUserId?: string | null;
  read?: boolean;
  createdAt?: string;
}

export type AgentStatus = 'online' | 'away' | 'busy' | 'offline';

// Augment Socket.data typing (kept local to avoid leaking into global scope)
type ChatSocket = Socket & {
  data: SocketAuthData & Record<string, unknown>;
};

// ============================================
// Module state
// ============================================

let ioServer: SocketIOServer | null = null;
let chatNs: Namespace | null = null;

/** Returns the /chat namespace. Throws if Socket.IO wasn't initialized yet. */
export function getIO(): Namespace {
  if (!chatNs) {
    throw new Error('Socket.IO not initialized. Call initSocket(httpServer) first.');
  }
  return chatNs;
}

/** Returns the underlying Socket.IO server (root). */
export function getIOServer(): SocketIOServer {
  if (!ioServer) {
    throw new Error('Socket.IO not initialized. Call initSocket(httpServer) first.');
  }
  return ioServer;
}

// ============================================
// Helpers
// ============================================

function roomConv(accountId: string, conversationId: string): string {
  return `account:${accountId}:conv:${conversationId}`;
}

function roomAccount(accountId: string): string {
  return `account:${accountId}`;
}

function roomUser(accountId: string | null | undefined, userId: string): string {
  // Mesmo super_admin sem accountId precisa receber suas próprias notificações,
  // então fallback pra '_' quando não há conta vinculada.
  const acc = accountId || '_';
  return `account:${acc}:user:${userId}`;
}

function extractToken(socket: Socket): string | null {
  // 1) handshake.auth.token (preferido — definido pelo frontend)
  const authToken = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof authToken === 'string' && authToken.trim()) {
    return authToken.trim();
  }

  // 2) Authorization: Bearer <token>
  const header =
    socket.handshake.headers.authorization ||
    (socket.handshake.headers.Authorization as string | undefined);
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.substring(7).trim();
  }

  // 3) Query string ?token=...
  const qToken = socket.handshake.query?.token;
  if (typeof qToken === 'string' && qToken.trim()) {
    return qToken.trim();
  }

  return null;
}

// ============================================
// Init
// ============================================

/**
 * Inicializa o Socket.IO em cima de um HTTP server. Idempotente: chamadas
 * subsequentes retornam o namespace já criado.
 */
export function initSocket(httpServer: HttpServer): Namespace {
  if (chatNs && ioServer) return chatNs;

  // CORS — mesma lógica do Express
  const corsOrigins = isDevelopment
    ? ['http://localhost:8080', 'http://localhost:5173', 'http://127.0.0.1:8080']
    : env.CORS_ORIGINS
      ? env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
      : [env.FRONTEND_URL];

  ioServer = new SocketIOServer(httpServer, {
    cors: {
      origin: corsOrigins,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // Ping/pong default (25s/20s) é suficiente; cliente também emite 'heartbeat'.
    pingInterval: 25_000,
    pingTimeout: 20_000,
  });

  chatNs = ioServer.of('/chat');

  // ------------------------------------------
  // Auth middleware (JWT)
  // ------------------------------------------
  chatNs.use(async (socket, next) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next(new Error('UNAUTHENTICATED: missing token'));
      }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
      } catch (err) {
        if (err instanceof jwt.TokenExpiredError) {
          return next(new Error('TOKEN_EXPIRED'));
        }
        return next(new Error('TOKEN_INVALID'));
      }

      // Valida usuário ativo (mesma checagem do middleware HTTP)
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          role: true,
          accountId: true,
          status: true,
          account: { select: { status: true } },
        },
      });

      if (!user) return next(new Error('USER_NOT_FOUND'));
      if (user.status !== 'active') return next(new Error('USER_INACTIVE'));
      if (user.role !== 'super_admin' && user.account?.status === 'paused') {
        return next(new Error('ACCOUNT_PAUSED'));
      }

      const data: SocketAuthData = {
        userId: user.id,
        accountId: user.accountId,
        role: user.role,
      };
      Object.assign(socket.data, data);

      next();
    } catch (err) {
      logger.warn('[socket] auth error', {
        error: err instanceof Error ? err.message : String(err),
      });
      next(new Error('AUTH_ERROR'));
    }
  });

  // ------------------------------------------
  // Connection
  // ------------------------------------------
  chatNs.on('connection', (rawSocket) => {
    const socket = rawSocket as ChatSocket;
    const { userId, accountId } = socket.data;

    // Sala da conta + sala direta do usuário
    if (accountId) socket.join(roomAccount(accountId));
    socket.join(roomUser(accountId, userId));

    logger.debug('[socket] cliente conectado', {
      socketId: socket.id,
      userId,
      accountId,
    });

    // Marca presença como online assim que conecta (best-effort).
    agentAvailabilityService.heartbeat(userId).catch((err) =>
      logger.warn('[socket] heartbeat inicial falhou', {
        userId,
        error: err instanceof Error ? err.message : String(err),
      })
    );

    // join-conversation
    socket.on('join-conversation', async (raw: unknown) => {
      try {
        const conversationId =
          typeof raw === 'string'
            ? raw
            : (raw as { conversationId?: string } | null)?.conversationId;
        if (!conversationId) return;
        if (!accountId) return; // super_admin sem conta não escuta conversas

        // Garante que a conversa pertence à conta antes de entrar na sala.
        const conv = await prisma.conversation.findFirst({
          where: { id: conversationId, accountId },
          select: { id: true },
        });
        if (!conv) return;

        socket.join(roomConv(accountId, conversationId));
      } catch (err) {
        logger.warn('[socket] join-conversation erro', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // leave-conversation
    socket.on('leave-conversation', (raw: unknown) => {
      const conversationId =
        typeof raw === 'string'
          ? raw
          : (raw as { conversationId?: string } | null)?.conversationId;
      if (!conversationId || !accountId) return;
      socket.leave(roomConv(accountId, conversationId));
    });

    // typing — broadcast pra sala da conversa (exceto o próprio remetente)
    socket.on('typing', (raw: unknown) => {
      if (!accountId) return;
      const payload = (raw ?? {}) as { conversationId?: string; isTyping?: boolean };
      if (!payload.conversationId) return;

      socket.to(roomConv(accountId, payload.conversationId)).emit('typing', {
        conversationId: payload.conversationId,
        userId,
        isTyping: Boolean(payload.isTyping),
      });
    });

    // heartbeat — mantém presença viva
    socket.on('heartbeat', () => {
      agentAvailabilityService.heartbeat(userId).catch((err) =>
        logger.debug('[socket] heartbeat falhou', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        })
      );
    });

    // disconnect
    socket.on('disconnect', (reason) => {
      logger.debug('[socket] cliente desconectado', {
        socketId: socket.id,
        userId,
        reason,
      });
    });
  });

  logger.info('🔌 Socket.IO inicializado no namespace /chat');

  return chatNs;
}

// ============================================
// Emitters (helpers expostos pros services)
// ============================================

/**
 * Emite que uma nova mensagem foi criada numa conversa.
 * Vai pra sala da conversa (todos que abriram aquele chat).
 */
export function emitMessageCreated(
  accountId: string,
  conversationId: string,
  message: unknown
): void {
  if (!chatNs || !accountId || !conversationId) return;
  chatNs.to(roomConv(accountId, conversationId)).emit('message:created', {
    conversationId,
    message,
  });
}

/**
 * Emite que a conversa foi atualizada (status, prioridade, label etc).
 * Vai pra sala da conversa E pra sala da conta (lista de conversas).
 */
export function emitConversationUpdated(
  accountId: string,
  conversationId: string,
  conversation: unknown
): void {
  if (!chatNs || !accountId || !conversationId) return;
  const payload = { conversationId, conversation };
  chatNs.to(roomConv(accountId, conversationId)).emit('conversation:updated', payload);
  chatNs.to(roomAccount(accountId)).emit('conversation:updated', payload);
}

/**
 * Emite que a conversa foi atribuída a um agente/time.
 * `assignee` pode ser o user/team retornado ou apenas o id; deixamos genérico.
 */
export function emitConversationAssigned(
  accountId: string,
  conversationId: string,
  assignee: unknown
): void {
  if (!chatNs || !accountId || !conversationId) return;
  const payload = { conversationId, assignee };
  chatNs.to(roomConv(accountId, conversationId)).emit('conversation:assigned', payload);
  chatNs.to(roomAccount(accountId)).emit('conversation:assigned', payload);
}

/**
 * Emite uma menção direta pro usuário citado. Usa a sala direta do usuário
 * (todas as sessões/abas dele recebem).
 */
export function emitMention(userId: string, mention: MentionPayload): void {
  if (!chatNs || !userId || !mention) return;
  // Como nem sempre temos o accountId aqui, usamos um broadcast amplo no
  // padrão da sala direta — initSocket fez o user entrar em
  // account:${accountId}:user:${userId}. Para garantir entrega independente
  // do accountId conhecido, emitimos no padrão de room que comece com
  // user:${userId} via socket lookup.
  for (const [, socket] of chatNs.sockets) {
    if ((socket.data as SocketAuthData).userId === userId) {
      socket.emit('mention:new', mention);
    }
  }
}

/**
 * Emite mudança de status de presença de um agente pra todos da conta.
 */
export function emitAgentStatusChanged(
  accountId: string,
  userId: string,
  status: AgentStatus
): void {
  if (!chatNs || !accountId || !userId) return;
  chatNs.to(roomAccount(accountId)).emit('agent:status', {
    userId,
    status,
  });
}
