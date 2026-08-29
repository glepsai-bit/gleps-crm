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

/**
 * AUDIT-SOCKET-RBAC: sala exclusiva de admins/super_admins da conta — recebem
 * eventos de TODAS as conversas (equivalente ao antigo broadcast tenant-wide,
 * mas sem incluir agentes com visibilidade restrita).
 */
function roomAdmins(accountId: string): string {
  return `account:${accountId}:admins`;
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
        // Mesmo algoritmo fixado do auth.middleware — o socket é outra porta
        // de entrada com o mesmo segredo, e uma barreira só nas rotas HTTP
        // deixaria a outra metade aberta.
        payload = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
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
    // AUDIT-SOCKET-RBAC: admins/super_admins acompanham todas as conversas.
    if (accountId && socket.data.role !== 'agent') {
      socket.join(roomAdmins(accountId));
    }

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
          select: { id: true, assigneeId: true, teamId: true },
        });
        if (!conv) return;

        // AUDIT-SOCKET-RBAC: agente só entra na sala da conversa se tiver
        // acesso (assignee/participante/membro do time) — mesmo critério de
        // conversation.service.assertAgentCanAccess. Sem isso, qualquer
        // agente assinava message:created/typing de qualquer conversa do
        // tenant, contornando o RBAC do REST.
        if (socket.data.role === 'agent') {
          let allowed = conv.assigneeId === userId;
          if (!allowed) {
            const participant = await prisma.conversationParticipant.findFirst({
              where: { conversationId, userId },
              select: { id: true },
            });
            allowed = Boolean(participant);
          }
          if (!allowed && conv.teamId) {
            const member = await prisma.teamMember.findFirst({
              where: { teamId: conv.teamId, userId },
              select: { id: true },
            });
            allowed = Boolean(member);
          }
          if (!allowed) {
            logger.warn('[socket] join-conversation negado (RBAC de agente)', {
              userId,
              conversationId,
            });
            return;
          }
        }

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

    // heartbeat — mantém presença viva + revalida JWT/status periodicamente
    // (SE-H4) evita que sessões antigas sigam recebendo eventos após logout /
    // desativação caso o disconnect explícito tenha perdido essa conexão por
    // race condition ou TCP que ainda não caiu.
    socket.on('heartbeat', async () => {
      try {
        const token = extractToken(socket);
        if (!token) {
          socket.emit('auth:revoked', { reason: 'TOKEN_MISSING' });
          socket.disconnect(true);
          return;
        }

        try {
          jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
        } catch (err) {
          const reason =
            err instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
          socket.emit('auth:revoked', { reason });
          socket.disconnect(true);
          return;
        }

        // Revalida estado do usuário / conta no banco a cada heartbeat
        // (cliente bate ~a cada 30s, então a janela de exposição é curta).
        const fresh = await prisma.user.findUnique({
          where: { id: userId },
          select: {
            status: true,
            role: true,
            accountId: true,
            account: { select: { status: true } },
          },
        });

        if (!fresh) {
          socket.emit('auth:revoked', { reason: 'USER_NOT_FOUND' });
          socket.disconnect(true);
          return;
        }
        if (fresh.status !== 'active') {
          socket.emit('auth:revoked', { reason: 'USER_INACTIVE' });
          socket.disconnect(true);
          return;
        }
        if (fresh.role !== 'super_admin' && fresh.account?.status === 'paused') {
          socket.emit('auth:revoked', { reason: 'ACCOUNT_PAUSED' });
          socket.disconnect(true);
          return;
        }
      } catch (err) {
        // Em caso de falha inesperada na revalidação, só loga — não derruba
        // a sessão (evita falso positivo por hiccup de DB).
        logger.warn('[socket] heartbeat revalidação falhou', {
          userId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

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
 * CHAT-REPLY-EDIT-DEL: emite que uma mensagem existente foi mutada
 * (edit de conteúdo ou soft delete). Vai pra sala da conversa — todos os
 * agentes com a thread aberta atualizam o cache no mesmo tick, sem F5.
 *
 * Payload leva a mensagem completa (com `content`, `deletedAt`, `metadata`),
 * pra que o frontend aplique PATCH direto no cache do thread sem precisar
 * refetch de /conversations/:id.
 */
export function emitMessageUpdated(
  accountId: string,
  conversationId: string,
  message: unknown
): void {
  if (!chatNs || !accountId || !conversationId) return;
  chatNs.to(roomConv(accountId, conversationId)).emit('message:updated', {
    conversationId,
    message,
  });
}

/**
 * CHAT-REACTIONS FURO 2: emite atualização de reactions agregadas de uma
 * mensagem (após addReaction / removeReaction / recordCustomerReaction).
 *
 * Todos os clientes conectados na sala da conversa recebem o aggregate
 * atualizado (mesmo shape retornado em list/get) e trocam as pills sem
 * refetch. Sem este evento, dois agentes vendo a mesma thread ficavam
 * dessincronizados — o agente B só descobria que o agente A reagiu
 * após F5. Idem pro emoji do cliente WhatsApp vindo via webhook.
 */
export function emitMessageReactionUpdated(
  accountId: string,
  conversationId: string,
  messageId: string,
  reactions: unknown
): void {
  if (!chatNs || !accountId || !conversationId || !messageId) return;
  chatNs.to(roomConv(accountId, conversationId)).emit('message:reaction:updated', {
    conversationId,
    messageId,
    reactions,
  });
}

/**
 * AUDIT-SOCKET-RBAC: resolve as salas autorizadas a receber eventos de uma
 * conversa: sala da conversa (join já passa por RBAC), admins da conta,
 * assignee, participantes e membros do time. Substitui o broadcast
 * tenant-wide (roomAccount) que entregava PII do contato (nome/telefone/
 * email) a agentes sem acesso àquela conversa.
 */
async function resolveConversationRooms(
  accountId: string,
  conversationId: string
): Promise<string[]> {
  const rooms = [roomConv(accountId, conversationId), roomAdmins(accountId)];
  try {
    const conv = await prisma.conversation.findFirst({
      where: { id: conversationId, accountId },
      select: {
        assigneeId: true,
        participants: { select: { userId: true } },
        team: { select: { members: { select: { userId: true } } } },
      },
    });
    if (conv) {
      const userIds = new Set<string>();
      if (conv.assigneeId) userIds.add(conv.assigneeId);
      for (const p of conv.participants) userIds.add(p.userId);
      for (const m of conv.team?.members ?? []) userIds.add(m.userId);
      for (const uid of userIds) rooms.push(roomUser(accountId, uid));
    }
  } catch (err) {
    logger.warn('[socket] resolveConversationRooms falhou — emitindo só para salas base', {
      conversationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return rooms;
}

/**
 * Emite que a conversa foi atualizada (status, prioridade, label etc).
 * Vai pra sala da conversa, admins e usuários com acesso (não mais a conta toda).
 */
export function emitConversationUpdated(
  accountId: string,
  conversationId: string,
  conversation: unknown
): void {
  if (!chatNs || !accountId || !conversationId) return;
  const payload = { conversationId, conversation };
  void resolveConversationRooms(accountId, conversationId).then((rooms) => {
    chatNs?.to(rooms).emit('conversation:updated', payload);
  });
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
  // AUDIT-SOCKET-RBAC: idem conversation:updated — salas restritas.
  void resolveConversationRooms(accountId, conversationId).then((rooms) => {
    chatNs?.to(rooms).emit('conversation:assigned', payload);
  });
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

/**
 * SE-H3: emite mudança de conexão de um Inbox (WhatsApp/Evolution) pra UI da conta.
 * Disparado quando connection.update vinda do Evolution muda o estado da instância
 * (open|connecting|close|logout) — permite que o admin veja em tempo real que o
 * número desconectou (logout/ban) sem precisar dar refresh.
 */
export function emitInboxConnection(
  accountId: string,
  payload: {
    inboxId: string;
    evolutionInstance: string | null;
    state: string;
    active: boolean;
  }
): void {
  if (!chatNs || !accountId || !payload?.inboxId) return;
  chatNs.to(roomAccount(accountId)).emit('inbox:connection', payload);
}

// ============================================
// Forced disconnect (SE-H4)
// ============================================

/**
 * SE-H4: derruba TODAS as conexões abertas de um determinado userId
 * (todas as sessões/abas), opcionalmente com um motivo enviado ao cliente.
 *
 * Chamado em:
 *  - logout (revoga refresh token + mata sockets vivos)
 *  - desativação/suspensão de usuário
 *  - mudança de status de conta (paused)
 *
 * Sem isso, o middleware /chat só valida o JWT no handshake — uma sessão
 * já aberta continua recebendo message:created e mention:new mesmo após
 * logout / suspensão, até o TCP cair.
 */
export function disconnectUserSockets(userId: string, reason?: string): number {
  if (!chatNs || !userId) return 0;
  let count = 0;
  for (const [, socket] of chatNs.sockets) {
    if ((socket.data as SocketAuthData).userId === userId) {
      try {
        if (reason) {
          socket.emit('auth:revoked', { reason });
        }
        socket.disconnect(true);
        count += 1;
      } catch (err) {
        logger.warn('[socket] falha ao desconectar sessão', {
          userId,
          socketId: socket.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (count > 0) {
    logger.info('[socket] sessões forçadamente encerradas', {
      userId,
      reason: reason ?? 'unspecified',
      count,
    });
  }
  return count;
}

/**
 * SE-H4: derruba TODAS as conexões abertas de uma conta — usado quando a
 * conta é pausada/encerrada e todos os usuários daquele tenant precisam
 * perder acesso ao realtime imediatamente.
 */
export function disconnectAccountSockets(accountId: string, reason?: string): number {
  if (!chatNs || !accountId) return 0;
  let count = 0;
  for (const [, socket] of chatNs.sockets) {
    if ((socket.data as SocketAuthData).accountId === accountId) {
      try {
        if (reason) {
          socket.emit('auth:revoked', { reason });
        }
        socket.disconnect(true);
        count += 1;
      } catch (err) {
        logger.warn('[socket] falha ao desconectar sessão (account)', {
          accountId,
          socketId: socket.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  if (count > 0) {
    logger.info('[socket] sessões da conta forçadamente encerradas', {
      accountId,
      reason: reason ?? 'unspecified',
      count,
    });
  }
  return count;
}
