import { Router } from 'express';
import { adminUserController } from '../controllers/admin-user.controller';
import {
  authenticate,
  requireAdmin,
  requireAccountId,
  requireSameAccountUser,
  verifyPassword,
} from '../middlewares/auth.middleware';

/**
 * T-024 — /api/admin/users
 *
 * Rotas dedicadas ao Admin de conta gerenciar agentes/admins da PROPRIA
 * tenancy. Separadas de /api/users (que serve o super_admin via UI super).
 *
 * Middlewares globais:
 * - authenticate: exige JWT valido
 * - requireAdmin: aceita admin OU super_admin
 * - requireAccountId: garante que requester tem accountId (bloqueia super_admin sem impersonation)
 *
 * Para rotas com :id adicionamos requireSameAccountUser para impedir
 * cross-tenant read/write (404 em divergencia, sem vazar existencia).
 */

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

// Limits (deve vir ANTES de /:id pra nao colidir)
router.get('/limits', (req, res, next) => adminUserController.getLimits(req, res, next));

// Coleção
router.get('/', (req, res, next) => adminUserController.list(req, res, next));
router.post('/', (req, res, next) => adminUserController.create(req, res, next));

// Itens
router.get('/:id', requireSameAccountUser('id'), (req, res, next) =>
  adminUserController.getById(req, res, next)
);
router.put('/:id', requireSameAccountUser('id'), (req, res, next) =>
  adminUserController.update(req, res, next)
);
router.delete(
  '/:id',
  requireSameAccountUser('id'),
  verifyPassword,
  (req, res, next) => adminUserController.delete(req, res, next)
);

export default router;
