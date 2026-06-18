/**
 * T-017 — Rotas do "human-in-the-loop" pós-consulta.
 *
 * Apelido /appointments para mexer com CalendarEvent (type=appointment).
 * Todas as rotas exigem auth + accountId.
 */
import { Router } from 'express';
import { appointmentController } from '../controllers/appointment.controller';
import { authenticate, requireAccountId, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAccountId);

router.get(
  '/pending-status',
  requirePermission('agenda'),
  (req, res, next) => appointmentController.listPendingStatus(req, res, next),
);

router.patch(
  '/:id/attendance',
  requirePermission('agenda'),
  (req, res, next) => appointmentController.markAttendance(req, res, next),
);

router.patch(
  '/:id/outcome',
  requirePermission('agenda'),
  (req, res, next) => appointmentController.markOutcome(req, res, next),
);

export default router;
