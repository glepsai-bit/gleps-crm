/**
 * CHAT METRICS ROUTES — T-022 Sprint 4 (Chat interno)
 *
 * Métricas só para super_admin / admin. Agentes individuais consultam o próprio
 * desempenho via `/dashboard` (ou rota dedicada futura).
 */

import { Router } from 'express';
import { chatMetricsController } from '../controllers/chat-metrics.controller';
import { authenticate, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate, requireRole('super_admin', 'admin'));

router.get('/metrics', (req, res, next) =>
  chatMetricsController.getMetrics(req, res, next)
);

router.get('/metrics/agent/:userId', (req, res, next) =>
  chatMetricsController.getAgentMetrics(req, res, next)
);

export default router;
