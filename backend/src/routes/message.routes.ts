import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  authenticate,
  requireAccountId,
  requireRole,
} from '../middlewares/auth.middleware';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { messageController } from '../controllers/message.controller';

// H-CHAT-2: rate-limit dedicado para criação de mensagens. O limiter
// global em server.ts (1000 req / 15 min) é generoso o bastante para
// permitir spam de 100 POSTs em 2s no /messages — que enfileira no
// Evolution, polui o histórico da conversa e pode até bloquear o número
// no WhatsApp. 30 msgs/min/IP cobre o uso humano normal (incluindo
// digitação rápida) e barra automação abusiva no mesmo padrão do
// authLimiter de C8.
const messageLimiter = rateLimit({
  windowMs: 60_000, // 1 minuto
  max: 30, // 30 msgs/min/IP (suficiente pra uso normal)
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'TOO_MANY_MESSAGES',
    message: 'Muitas mensagens. Aguarde.',
  },
});

// ============================================
// JWT Router — usuários autenticados (agent / admin / super_admin)
//
// Mountar com prefixo VAZIO (ex: router.use('/', jwtRouter)) porque as rotas
// abaixo usam paths absolutos distintos:
//   GET    /conversations/:conversationId/messages
//   POST   /conversations/:conversationId/messages
//   POST   /messages/:id/read
//   GET    /messages/search
// ============================================

const jwtRouter = Router();

jwtRouter.use(authenticate);
jwtRouter.use(requireRole('super_admin', 'admin', 'agent'));
jwtRouter.use(requireAccountId);

jwtRouter.get('/conversations/:conversationId/messages', (req, res, next) =>
  messageController.list(req, res, next)
);

jwtRouter.post(
  '/conversations/:conversationId/messages',
  messageLimiter,
  (req, res, next) => messageController.create(req, res, next)
);

jwtRouter.post('/messages/:id/read', (req, res, next) =>
  messageController.markRead(req, res, next)
);

// CHAT-MSG-FAILED-007: retry de mensagem failed (ex.: Evolution 400 transient).
jwtRouter.post('/messages/:id/retry', (req, res, next) =>
  messageController.retry(req, res, next)
);

jwtRouter.get('/messages/search', (req, res, next) =>
  messageController.search(req, res, next)
);

// ============================================
// CHAT-REPLY-EDIT-DEL — edit + soft delete outbound (janela 15 min)
// ============================================
// Reutilizamos o `messageLimiter` no PATCH porque um agente rebelde pode
// spammar edições no mesmo ritmo que criações. DELETE fica sem limiter próprio
// (evento raro, e o service já enforça janela + ownership).

jwtRouter.patch('/messages/:id', messageLimiter, (req, res, next) =>
  messageController.update(req, res, next)
);

jwtRouter.delete('/messages/:id', (req, res, next) =>
  messageController.remove(req, res, next)
);

// ============================================
// CHAT-REACTIONS — reactions de agente em qualquer mensagem
// ============================================
// GET não precisa de rate-limit (leitura). POST/DELETE pegam o mesmo
// `messageLimiter` — igual a POST /messages, evita spray de reactions.

jwtRouter.get('/messages/:id/reactions', (req, res, next) =>
  messageController.listReactions(req, res, next)
);

jwtRouter.post(
  '/messages/:id/reactions',
  messageLimiter,
  (req, res, next) => messageController.addReaction(req, res, next)
);

jwtRouter.delete(
  '/messages/:id/reactions/:emoji',
  messageLimiter,
  (req, res, next) => messageController.removeReaction(req, res, next)
);

// ============================================
// API Key Router — integrações externas (n8n, agente IA)
//
// Mountar em '/integrations/chat'.
//   POST /integrations/chat/conversations/:id/messages
// ============================================

const apiKeyRouter = Router();

apiKeyRouter.use(requireApiKey);

apiKeyRouter.post(
  '/conversations/:id/messages',
  messageLimiter,
  requireScope('messages:write', 'messages:notes'),
  (req, res, next) => messageController.createFromIntegration(req, res, next)
);

export { jwtRouter, apiKeyRouter };
export default jwtRouter;
