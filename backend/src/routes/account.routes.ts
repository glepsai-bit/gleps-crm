import { Router } from 'express';
import { accountController } from '../controllers/account.controller';
import { authenticate, requireSuperAdmin, verifyPassword } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication and Super Admin role
router.use(authenticate, requireSuperAdmin);

router.get('/', (req, res, next) => accountController.list(req, res, next));
router.post('/', (req, res, next) => accountController.create(req, res, next));
router.get('/:id', (req, res, next) => accountController.getById(req, res, next));
router.put('/:id', (req, res, next) => accountController.update(req, res, next));
router.delete('/:id', verifyPassword, (req, res, next) => accountController.delete(req, res, next));

router.post('/:id/pause', (req, res, next) => accountController.pause(req, res, next));
router.post('/:id/activate', (req, res, next) => accountController.activate(req, res, next));
router.get('/:id/stats', (req, res, next) => accountController.getStats(req, res, next));

router.post('/:id/test-chatwoot', (req, res, next) => accountController.testChatwoot(req, res, next));
router.get('/:id/chatwoot-agents', (req, res, next) => accountController.getChatwootAgents(req, res, next));

export default router;
