import { Router, Request } from 'express';
import rateLimit from 'express-rate-limit';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationContactsController } from '../controllers/integration-contacts.controller';

/* ============================================================================
 * INTEGRATION CONTACTS ROUTES (T-CONTACTS-API)
 *
 * Endpoints para integrações externas (n8n, agentes IA) operarem o catálogo
 * de contatos via API key — sem JWT.
 *
 * Montado em '/integrations/contacts' (ver routes/index.ts).
 *
 *   POST   /                          → cria ou upsert por telefone
 *   GET    /                          → lista paginada com filtros (+ attr.*)
 *   GET    /by-phone/:phone           → busca exata por telefone normalizado
 *   PATCH  /:id                       → atualiza campos básicos
 *   PATCH  /:id/custom-attributes     → merge nos custom attrs
 *
 * Scopes:
 *   - leitura: contacts:read, contacts:write, *
 *   - escrita: contacts:write, *
 *
 * Rate limit: keyed por apiKey.id (fallback IP+path), conservador,
 * separado entre leitura e escrita.
 * ========================================================================= */

const integrationKey = (req: Request): string =>
  req.apiKey?.id ?? `ip:${req.ip ?? 'unknown'}:${req.path}`;

const readLimiter = rateLimit({
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

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 120,
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

// CREATE / UPSERT
router.post(
  '/',
  writeLimiter,
  requireScope('contacts:write'),
  (req, res, next) => integrationContactsController.create(req, res, next)
);

// LIST com filtros
router.get(
  '/',
  readLimiter,
  requireScope('contacts:read', 'contacts:write'),
  (req, res, next) => integrationContactsController.list(req, res, next)
);

// GET by phone (com ou sem +)
router.get(
  '/by-phone/:phone',
  readLimiter,
  requireScope('contacts:read', 'contacts:write'),
  (req, res, next) => integrationContactsController.getByPhone(req, res, next)
);

// PATCH custom attributes (merge) — registrado ANTES do PATCH /:id pra que
// `/:id/custom-attributes` não case com o handler genérico de update.
router.patch(
  '/:id/custom-attributes',
  writeLimiter,
  requireScope('contacts:write'),
  (req, res, next) =>
    integrationContactsController.patchCustomAttributes(req, res, next)
);

// PATCH campos básicos
router.patch(
  '/:id',
  writeLimiter,
  requireScope('contacts:write'),
  (req, res, next) => integrationContactsController.update(req, res, next)
);

export default router;
