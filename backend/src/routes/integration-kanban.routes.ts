import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationKanbanController } from '../controllers/integration-kanban.controller';

/* ============================================================================
 * INTEGRATION KANBAN ROUTES (T-KANBAN-API)
 *
 * Endpoints para integrações externas (n8n, agentes IA, ERPs) operarem o
 * funil do CRM via API key — sem usar a sessão JWT do app.
 *
 * Montado em '/integrations/kanban' (ver routes/index.ts).
 *
 *   GET  /stages                    → lista etapas do funil default
 *   POST /leads/:leadId/stage       → move o lead para a etapa indicada
 *
 * Scopes aceitos (whitelisted no requireScope):
 *   - leitura: 'kanban:read', 'kanban:write', 'leads:read', 'leads:write', '*'
 *   - escrita: 'kanban:write', 'leads:write', '*'
 *
 *   Alinhamos os nomes com as permissões JWT (`leads`/`kanban`) para que
 *   chaves emitidas por admins sigam o vocabulário do app.
 *
 * BUG 9 FIX (rate limit):
 *   Sem limite, uma API key vazada/compartilhada (ou um loop n8n defeituoso)
 *   floodava o backend. Adicionamos dois limiters keyed por apiKey.id (com
 *   fallback IP+path) montados ANTES dos handlers — independentes entre
 *   leitura e escrita para não bloquear o discovery quando o write atinge
 *   o teto. Limites iniciais conservadores; podem ser afrouxados se um
 *   integrador legítimo provar volume maior.
 * ========================================================================= */

const integrationKey = (req: Request): string =>
  req.apiKey?.id ?? `ip:${req.ip ?? 'unknown'}:${req.path}`;

const integrationReadLimiter = rateLimit({
  windowMs: 60_000, // 1 min
  max: 300, // 300 reads/min/apiKey
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
  windowMs: 60_000, // 1 min
  max: 60, // 60 writes/min/apiKey
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

// Listagem das etapas disponíveis na conta (chamado antes de mover lead)
router.get(
  '/stages',
  integrationReadLimiter,
  requireScope('kanban:read', 'kanban:write', 'leads:read', 'leads:write'),
  (req, res, next) => integrationKanbanController.listStages(req, res, next)
);

// Move o lead para uma etapa específica
router.post(
  '/leads/:leadId/stage',
  integrationWriteLimiter,
  requireScope('kanban:write', 'leads:write'),
  (req, res, next) => integrationKanbanController.moveStage(req, res, next)
);

export default router;
