import { Router } from 'express';
import { eventController } from '../controllers/event.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/', requirePermission('events'), (req, res, next) => eventController.list(req, res, next));
router.get('/user-activity', requirePermission('events'), (req, res, next) => eventController.getUserActivity(req, res, next));
router.get('/online-status', (req, res, next) => eventController.getOnlineStatus(req, res, next));
router.get('/stats', requirePermission('events'), (req, res, next) => eventController.getStats(req, res, next));
router.get('/:id', requirePermission('events'), (req, res, next) => eventController.getById(req, res, next));

export default router;
