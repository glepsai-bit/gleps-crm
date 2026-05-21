import { Router, Request, Response, NextFunction } from 'express';
import { calendarController } from '../controllers/calendar.controller';
import { authenticate, requirePermission, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// Google callback must be PUBLIC (no JWT — Google redirects here)
router.get('/google/callback', (req: Request, res: Response, next: NextFunction) => calendarController.googleCallback(req as any, res, next));

// All other routes require authentication + accountId
router.use(authenticate);
router.use(requireAccountId);

router.get('/events', requirePermission('agenda'), (req, res, next) => calendarController.list(req, res, next));
router.post('/events', requirePermission('agenda'), (req, res, next) => calendarController.create(req, res, next));
router.get('/events/:id', requirePermission('agenda'), (req, res, next) => calendarController.getById(req, res, next));
router.put('/events/:id', requirePermission('agenda'), (req, res, next) => calendarController.update(req, res, next));
router.delete('/events/:id', requirePermission('agenda'), (req, res, next) => calendarController.delete(req, res, next));

// Google Calendar integration (Admin only)
router.post('/google/connect', requireAdmin, (req, res, next) => calendarController.connectGoogle(req, res, next));
router.post('/google/disconnect', requireAdmin, (req, res, next) => calendarController.disconnectGoogle(req, res, next));
router.post('/google/sync', requireAdmin, (req, res, next) => calendarController.syncGoogle(req, res, next));
router.get('/google/status', (req, res, next) => calendarController.getGoogleStatus(req, res, next));

export default router;
