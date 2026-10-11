/**
 * CHAT METRICS ROUTES — T-022 Sprint 4 (Chat interno)
 *
 * Métricas para super_admin / admin e para o agente que tem a permissão
 * `dashboard` (é o que o item "Dashboard" do menu exige no front).
 */

import { Router } from 'express';
import { chatMetricsController } from '../controllers/chat-metrics.controller';
import { authenticate, requirePermission, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate, requireRole('super_admin', 'admin', 'agent'), requirePermission('dashboard'));

router.get('/metrics', (req, res, next) =>
  chatMetricsController.getMetrics(req, res, next)
);

router.get('/metrics/agent/:userId', (req, res, next) =>
  chatMetricsController.getAgentMetrics(req, res, next)
);

// T-022 — Cards do dashboard: leads que retornaram + atendimento ao vivo.
// IMPORTANTE: a rota `/returning-leads/list` PRECISA vir antes de
// `/returning-leads` se houvesse colisão; Express casa rotas estáticas
// distintas então a ordem não importa aqui, mas mantemos juntas pra clareza.
router.get('/returning-leads/list', (req, res, next) =>
  chatMetricsController.getReturningLeadsList(req, res, next)
);

router.get('/returning-leads', (req, res, next) =>
  chatMetricsController.getReturningLeads(req, res, next)
);

router.get('/live-attendance', (req, res, next) =>
  chatMetricsController.getLiveAttendance(req, res, next)
);

export default router;
