import { Router } from 'express';
import { tagController, funnelController } from '../controllers/tag.controller';
import {
  authenticate,
  requirePermission,
  requireAdmin,
  requireAccountId,
} from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);
/**
 * `requireAccountId` depois do `authenticate`: os controllers desta rota leem
 * `req.user!.accountId!`, e esse `!` mente — a coluna é nullable, e um
 * super_admin sem impersonar chega aqui com accountId nulo. No Prisma,
 * `where: { accountId: undefined }` não devolve zero linhas: ele REMOVE o
 * filtro e devolve as de todas as contas. A guarda troca esse silêncio por um
 * 400 explícito. Nada aqui é de uso do painel super-admin.
 */
router.use(requireAccountId);

// Tag routes
router.get('/', requirePermission('kanban', 'leads'), (req, res, next) => tagController.list(req, res, next));
router.post('/', requireAdmin, (req, res, next) => tagController.create(req, res, next));
router.get('/kanban', requirePermission('kanban'), (req, res, next) => tagController.getKanbanData(req, res, next));
router.post('/reorder', requireAdmin, (req, res, next) => tagController.reorderBulk(req, res, next));
router.post('/sync-labels', requireAdmin, (req, res, next) => tagController.syncLabels(req, res, next));

router.get('/:id', requirePermission('kanban', 'leads'), (req, res, next) => tagController.getById(req, res, next));
router.put('/:id', requireAdmin, (req, res, next) => tagController.update(req, res, next));
router.delete('/:id', requireAdmin, (req, res, next) => tagController.delete(req, res, next));
router.patch('/:id/order', requireAdmin, (req, res, next) => tagController.reorder(req, res, next));
router.get('/:id/contacts', requirePermission('kanban', 'leads'), (req, res, next) => tagController.getContactsByStage(req, res, next));

export default router;

// Funnel routes
export const funnelRouter = Router();
funnelRouter.use(authenticate);

funnelRouter.get('/', requirePermission('kanban'), (req, res, next) => funnelController.list(req, res, next));
funnelRouter.post('/', requireAdmin, (req, res, next) => funnelController.create(req, res, next));
funnelRouter.get('/:id', requirePermission('kanban'), (req, res, next) => funnelController.getById(req, res, next));
funnelRouter.put('/:id', requireAdmin, (req, res, next) => funnelController.update(req, res, next));
funnelRouter.delete('/:id', requireAdmin, (req, res, next) => funnelController.delete(req, res, next));
