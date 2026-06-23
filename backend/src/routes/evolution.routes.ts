import { Router } from 'express';
import { evolutionController } from '../controllers/evolution.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

// ============================================
// Public webhook (no auth) — recebe eventos da Evolution API
// ============================================
// TODO(sprint-futura): adicionar middleware de validação HMAC
router.post('/webhook/:accountId', (req, res, next) =>
  evolutionController.receiveWebhook(req, res, next)
);

// ============================================
// Authenticated routes (super_admin ou admin)
// ============================================
router.get(
  '/accounts/:accountId/qrcode',
  authenticate,
  requireRole('super_admin', 'admin'),
  (req, res, next) => evolutionController.getQrCode(req, res, next)
);

router.get(
  '/accounts/:accountId/status',
  authenticate,
  requireRole('super_admin', 'admin'),
  (req, res, next) => evolutionController.getStatus(req, res, next)
);

router.post(
  '/accounts/:accountId/disconnect',
  authenticate,
  requireRole('super_admin', 'admin'),
  (req, res, next) => evolutionController.disconnect(req, res, next)
);

export default router;
