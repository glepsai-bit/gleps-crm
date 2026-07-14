import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationChatController } from '../controllers/integration-chat.controller';

/* ============================================================================
 * INTEGRATION CHAT ROUTES (T-CHAT-API)
 *
 * Endpoints externos (n8n / agentes IA / ERPs) para autonomia completa de
 * atendimento via API key — sem sessão JWT do CRM.
 *
 * Montado em '/integrations/chat' (ver routes/index.ts).
 *
 *   GET    /conversations/:id
 *   POST   /conversations/:id/messages
 *   POST   /conversations/:id/notes
 *   POST   /conversations/:id/assign
 *   POST   /conversations/:id/assign-team
 *   POST   /conversations/:id/transfer
 *   POST   /conversations/:id/resolve
 *   POST   /conversations/:id/reopen
 *   POST   /conversations/:id/send-csat
 *   PATCH  /conversations/:id/custom-attributes
 *   PATCH  /conversations/:id/priority
 *   POST   /conversations/:id/labels
 *   DELETE /conversations/:id/labels/:labelId
 *   POST   /conversations/:id/snooze
 *
 * Scopes aceitos:
 *   - leitura: 'chat:read', 'chat:write', '*'
 *   - escrita: 'chat:write', '*' (com aliases legados em send-message:
 *              'messages:write' continua válido pra não quebrar keys antigas).
 *
 * Rate limit: dois limiters (read 300/min, write 60/min) keyed por apiKey.id.
 * ========================================================================= */

const integrationKey = (req: Request): string =>
  req.apiKey?.id ?? `ip:${req.ip ?? 'unknown'}:${req.path}`;

const integrationReadLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: integrationKey,
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: 'Rate limit excedido para esta API key. Aguarde e tente novamente.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

const integrationWriteLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: integrationKey,
  message: {
    error: 'TOO_MANY_REQUESTS',
    message: 'Rate limit excedido para esta API key. Aguarde e tente novamente.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
});

const router = Router();

router.use(requireApiKey);

// ──────────────────────────────────────────────────────────────────────────
// READ
// ──────────────────────────────────────────────────────────────────────────
router.get(
  '/conversations/:id',
  integrationReadLimiter,
  requireScope('chat:read', 'chat:write'),
  (req, res, next) => integrationChatController.getConversation(req, res, next)
);

// Download da MIDIA de uma mensagem (audio/imagem/documento).
// O fileUrl que vai no webhook aponta pra /api/attachments/:id, que exige JWT —
// integracoes (n8n/IA) so tem API key e nao conseguiam baixar o audio do cliente
// pra transcrever. Este endpoint serve o mesmo arquivo, autenticado por API key
// e escopado pela conta da chave.
router.get(
  '/attachments/:id',
  integrationReadLimiter,
  requireScope('chat:read', 'chat:write'),
  (req, res, next) => integrationChatController.getAttachment(req, res, next)
);

// ──────────────────────────────────────────────────────────────────────────
// WRITE
// ──────────────────────────────────────────────────────────────────────────

// Send message — aceita 'messages:write' (alias legado) também
router.post(
  '/conversations/:id/messages',
  integrationWriteLimiter,
  requireScope('chat:write', 'messages:write'),
  (req, res, next) => integrationChatController.sendMessage(req, res, next)
);

// Send internal note
router.post(
  '/conversations/:id/notes',
  integrationWriteLimiter,
  requireScope('chat:write', 'messages:notes'),
  (req, res, next) => integrationChatController.sendNote(req, res, next)
);

// Assign agent
router.post(
  '/conversations/:id/assign',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.assign(req, res, next)
);

// Assign team
router.post(
  '/conversations/:id/assign-team',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.assignTeam(req, res, next)
);

// Transfer (agent OR team)
router.post(
  '/conversations/:id/transfer',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.transfer(req, res, next)
);

// Resolve
router.post(
  '/conversations/:id/resolve',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.resolve(req, res, next)
);

// Reopen
router.post(
  '/conversations/:id/reopen',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.reopen(req, res, next)
);

// Send CSAT now (SLA v2.1) — dispara avaliacao imediata pro cliente
router.post(
  '/conversations/:id/send-csat',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.sendCsat(req, res, next)
);

// Custom attributes (PATCH)
router.patch(
  '/conversations/:id/custom-attributes',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.setCustomAttributes(req, res, next)
);

// Priority (PATCH)
router.patch(
  '/conversations/:id/priority',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.setPriority(req, res, next)
);

// Labels — add (POST) / remove (DELETE)
router.post(
  '/conversations/:id/labels',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.addLabel(req, res, next)
);

router.delete(
  '/conversations/:id/labels/:labelId',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.removeLabel(req, res, next)
);

// Snooze
router.post(
  '/conversations/:id/snooze',
  integrationWriteLimiter,
  requireScope('chat:write'),
  (req, res, next) => integrationChatController.snooze(req, res, next)
);

export default router;
