import { Router } from 'express';
import { trackingController } from '../controllers/tracking.controller';
import { authenticate, requireAccountId, requireAdmin } from '../middlewares/auth.middleware';

const router = Router();

// TRACKING (Meta Ads / CTWA) — admin-only: envolve token da BM e gasto.
router.use(authenticate, requireAccountId, requireAdmin);

router.get('/config', (req, res, next) => trackingController.getConfig(req, res, next));
router.put('/config', (req, res, next) => trackingController.saveConfig(req, res, next));
router.get('/funnel', (req, res, next) => trackingController.getFunnel(req, res, next));
router.get('/events', (req, res, next) => trackingController.listEvents(req, res, next));
// Diagnóstico read-only (não envia nada) × reconciliação (envia à Meta).
router.post('/verify', (req, res, next) => trackingController.verify(req, res, next));
router.post('/reconcile', (req, res, next) => trackingController.reconcile(req, res, next));

export default router;
