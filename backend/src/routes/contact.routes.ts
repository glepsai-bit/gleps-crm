import { Router } from 'express';
import { contactController } from '../controllers/contact.controller';
import { authenticate, requirePermission, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication + accountId
router.use(authenticate);
router.use(requireAccountId);

router.get('/', requirePermission('leads', 'kanban'), (req, res, next) => contactController.list(req, res, next));
router.post('/', requirePermission('leads', 'kanban'), (req, res, next) => contactController.create(req, res, next));
router.get('/:id', requirePermission('leads', 'kanban'), (req, res, next) => contactController.getById(req, res, next));
router.put('/:id', requirePermission('leads', 'kanban'), (req, res, next) => contactController.update(req, res, next));
router.delete('/:id', requirePermission('leads'), (req, res, next) => contactController.delete(req, res, next));

router.get('/:id/sales', requirePermission('leads', 'sales'), (req, res, next) => contactController.getSales(req, res, next));
router.get('/:id/notes', requirePermission('leads', 'kanban'), (req, res, next) => contactController.getNotes(req, res, next));
router.post('/:id/notes', requirePermission('leads', 'kanban'), (req, res, next) => contactController.addNote(req, res, next));

router.get('/:id/tags', requirePermission('leads', 'kanban'), (req, res, next) => contactController.getTags(req, res, next));
router.post('/:id/tags', requirePermission('leads', 'kanban'), (req, res, next) => contactController.applyTag(req, res, next));
router.delete('/:id/tags/:tagId', requirePermission('leads', 'kanban'), (req, res, next) => contactController.removeTag(req, res, next));

router.get('/:id/history', requirePermission('leads', 'kanban'), (req, res, next) => contactController.getHistory(req, res, next));

export default router;
