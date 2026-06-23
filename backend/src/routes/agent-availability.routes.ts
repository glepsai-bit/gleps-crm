/**
 * AGENT AVAILABILITY ROUTES — T-022 Sprint 4 (Chat interno)
 *
 * Disponibilidade é por agente: qualquer role autenticada (super_admin, admin,
 * agent) pode consultar/atualizar o próprio status e o heartbeat. A listagem
 * de online é escopada pela conta corrente do usuário autenticado (multi-tenant).
 */

import { Router } from 'express';
import { agentAvailabilityController } from '../controllers/agent-availability.controller';
import { authenticate } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);

router.get('/me', (req, res, next) =>
  agentAvailabilityController.getMe(req, res, next)
);

router.post('/me', (req, res, next) =>
  agentAvailabilityController.setMe(req, res, next)
);

router.post('/heartbeat', (req, res, next) =>
  agentAvailabilityController.heartbeat(req, res, next)
);

router.get('/online', (req, res, next) =>
  agentAvailabilityController.listOnline(req, res, next)
);

export default router;
