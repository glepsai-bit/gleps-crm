import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationLookupController } from '../controllers/integration-lookup.controller';

/* ============================================================================
 * INTEGRATION LOOKUP ROUTES (T-LOOKUP-API)
 *
 * Endpoints de DISCOVERY para integrações externas (n8n / agentes IA):
 *
 *   GET /api/integrations/teams   → lista times da conta + agentsCount
 *   GET /api/integrations/users   → lista users (role / teamId / available)
 *
 * Scopes aceitos:
 *   - leitura: 'chat:read', 'chat:write', '*'
 *
 * Rate limit: read limiter (300/min keyed por apiKey.id) — mesmo padrão dos
 * outros routers de integração pra evitar abuse.
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

const router = Router();

router.use(requireApiKey);

router.get(
  '/teams',
  integrationReadLimiter,
  requireScope('chat:read', 'chat:write'),
  (req, res, next) => integrationLookupController.listTeams(req, res, next)
);

router.get(
  '/users',
  integrationReadLimiter,
  requireScope('chat:read', 'chat:write'),
  (req, res, next) => integrationLookupController.listUsers(req, res, next)
);

export default router;
