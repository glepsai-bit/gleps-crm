/**
 * T-023 — WhatsApp Warmup Routes
 *
 * Todas as rotas exigem JWT + accountId + role admin/super_admin.
 *
 *   POST   /pools                       criar pool
 *   GET    /pools                       listar pools (query includePublic)
 *   PATCH  /pools/:id                   editar pool
 *   DELETE /pools/:id                   excluir pool (cascade nos numbers)
 *
 *   POST   /numbers                     adicionar number
 *   GET    /numbers                     listar numbers (query poolId, status)
 *   POST   /numbers/:id/start           inicia protocolo (currentDay=1)
 *   POST   /numbers/:id/pause           pausa
 *   POST   /numbers/:id/resume          resume warming
 *   DELETE /numbers/:id                 excluir number
 *   GET    /numbers/:id/stats           ultimos 30 dias de stats
 */

import { Router } from 'express';
import { warmupController } from '../controllers/warmup.controller';
import {
  authenticate,
  requireAccountId,
  requireRole,
} from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAccountId);
router.use(requireRole('admin', 'super_admin'));

// ─── Pools ────────────────────────────────────────────────────────────────
router.get('/pools', (req, res, next) =>
  warmupController.listPools(req, res, next)
);
router.post('/pools', (req, res, next) =>
  warmupController.createPool(req, res, next)
);
router.patch('/pools/:id', (req, res, next) =>
  warmupController.updatePool(req, res, next)
);
router.delete('/pools/:id', (req, res, next) =>
  warmupController.deletePool(req, res, next)
);

// ─── Numbers ──────────────────────────────────────────────────────────────
router.get('/numbers', (req, res, next) =>
  warmupController.listNumbers(req, res, next)
);
router.post('/numbers', (req, res, next) =>
  warmupController.createNumber(req, res, next)
);
router.post('/numbers/:id/start', (req, res, next) =>
  warmupController.startNumber(req, res, next)
);
router.post('/numbers/:id/pause', (req, res, next) =>
  warmupController.pauseNumber(req, res, next)
);
router.post('/numbers/:id/resume', (req, res, next) =>
  warmupController.resumeNumber(req, res, next)
);
router.delete('/numbers/:id', (req, res, next) =>
  warmupController.deleteNumber(req, res, next)
);
router.get('/numbers/:id/stats', (req, res, next) =>
  warmupController.getNumberStats(req, res, next)
);

export default router;
