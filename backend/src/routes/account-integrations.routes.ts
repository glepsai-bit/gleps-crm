/**
 * T-025 — Rotas para self-service de chaves de IA.
 *
 * Acessivel por admin (e super_admin) da PROPRIA conta — requireAccountId
 * garante que super_admin sem accountId vinculado nao consiga rodar.
 */

import { Router } from 'express';
import {
  authenticate,
  requireAdmin,
  requireAccountId,
} from '../middlewares/auth.middleware';
import { accountIntegrationsController } from '../controllers/account-integrations.controller';

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

// GET /api/admin/integrations/ai
router.get('/ai', (req, res, next) => accountIntegrationsController.get(req as any, res, next));

// PATCH /api/admin/integrations/ai
router.patch('/ai', (req, res, next) => accountIntegrationsController.patch(req as any, res, next));

// POST /api/admin/integrations/ai/test/:provider
router.post('/ai/test/:provider', (req, res, next) =>
  accountIntegrationsController.test(req as any, res, next)
);

export default router;
