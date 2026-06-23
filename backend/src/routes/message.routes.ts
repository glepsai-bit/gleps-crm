import { Router } from 'express';
import {
  authenticate,
  requireAccountId,
  requireRole,
} from '../middlewares/auth.middleware';
import { requireApiKey } from '../middlewares/apiKey.middleware';
import { messageController } from '../controllers/message.controller';

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

jwtRouter.post('/conversations/:conversationId/messages', (req, res, next) =>
  messageController.create(req, res, next)
);

jwtRouter.post('/messages/:id/read', (req, res, next) =>
  messageController.markRead(req, res, next)
);

jwtRouter.get('/messages/search', (req, res, next) =>
  messageController.search(req, res, next)
);

// ============================================
// API Key Router — integrações externas (n8n, agente IA)
//
// Mountar em '/integrations/chat'.
//   POST /integrations/chat/conversations/:id/messages
// ============================================

const apiKeyRouter = Router();

apiKeyRouter.use(requireApiKey);

apiKeyRouter.post('/conversations/:id/messages', (req, res, next) =>
  messageController.createFromIntegration(req, res, next)
);

export { jwtRouter, apiKeyRouter };
export default jwtRouter;
