import { Router } from 'express';
import { customAttributeController } from '../controllers/custom-attribute.controller';
import {
  authenticate,
  requireAdmin,
  requireAccountId,
} from '../middlewares/auth.middleware';

/**
 * Custom Attribute Definitions Routes (T-022)
 *
 * Todas as rotas exigem:
 * - JWT válido (authenticate)
 * - Role admin ou super_admin (requireAdmin)
 * - accountId no usuário (requireAccountId) — super_admin precisa estar
 *   impersonando uma conta para gerenciar definições.
 */

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

router.get('/', (req, res, next) => customAttributeController.list(req, res, next));
router.get('/:id', (req, res, next) => customAttributeController.getById(req, res, next));
router.post('/', (req, res, next) => customAttributeController.create(req, res, next));
router.patch('/:id', (req, res, next) => customAttributeController.update(req, res, next));
router.delete('/:id', (req, res, next) => customAttributeController.delete(req, res, next));

export default router;
