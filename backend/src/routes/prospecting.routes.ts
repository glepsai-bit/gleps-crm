import { Router } from 'express';
import { prospectingController } from '../controllers/prospecting.controller';
import { prospectingAudienceController } from '../controllers/prospecting-audience.controller';
import { authenticate, requireAccountId, requireRole } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate, requireAccountId);
router.use(requireRole('admin', 'super_admin'));

router.post('/extract', (req, res, next) => prospectingController.extractLeads(req, res, next));
router.get('/usage', (req, res, next) => prospectingController.getUsage(req, res, next));
router.get('/inboxes', (req, res, next) => prospectingController.listInboxes(req, res, next));
router.post('/dispatch', (req, res, next) => prospectingController.dispatch(req, res, next));
router.post('/cancel', (req, res, next) => prospectingController.cancelBatch(req, res, next));
router.post('/resume', (req, res, next) => prospectingController.resumeBatch(req, res, next));
router.get('/batches', (req, res, next) => prospectingController.getBatches(req, res, next));
router.get('/batches/:batchId/logs', (req, res, next) => prospectingController.getBatchLogs(req, res, next));

// Saved audiences (públicos salvos)
router.get('/audiences', (req, res, next) => prospectingAudienceController.list(req, res, next));
router.post('/audiences', (req, res, next) => prospectingAudienceController.create(req, res, next));
router.get('/audiences/:id', (req, res, next) => prospectingAudienceController.getById(req, res, next));
router.delete('/audiences/:id', (req, res, next) => prospectingAudienceController.delete(req, res, next));

export default router;
