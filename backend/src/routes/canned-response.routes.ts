import { Router } from 'express';
import { cannedResponseController } from '../controllers/canned-response.controller';
import {
  authenticate,
  requireAdmin,
  requireAccountId,
} from '../middlewares/auth.middleware';

/**
 * Canned Responses Routes (T-022 — respostas prontas / chat interno)
 *
 * - GET (list/get): JWT + accountId (qualquer role, inclusive agent, para o
 *   autocomplete "/" no MessageComposer).
 * - POST/PATCH/DELETE: JWT + admin/super_admin + accountId (super_admin precisa
 *   estar impersonando uma conta).
 */

const router = Router();

// Auth + escopo de conta valem para todas as rotas
router.use(authenticate);
router.use(requireAccountId);

// Leitura — liberado para agents (autocomplete no chat)
router.get('/', (req, res, next) => cannedResponseController.list(req, res, next));
router.get('/:id', (req, res, next) => cannedResponseController.getById(req, res, next));

// Escrita — apenas admin/super_admin
router.post('/', requireAdmin, (req, res, next) =>
  cannedResponseController.create(req, res, next)
);
router.patch('/:id', requireAdmin, (req, res, next) =>
  cannedResponseController.update(req, res, next)
);
router.delete('/:id', requireAdmin, (req, res, next) =>
  cannedResponseController.delete(req, res, next)
);

export default router;
