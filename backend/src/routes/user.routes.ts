import { Router } from 'express';
import { userController } from '../controllers/user.controller';
import { authenticate, requireAdmin, requireSuperAdmin, verifyPassword } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

router.get('/', requireAdmin, (req, res, next) => userController.list(req, res, next));
router.post('/', requireAdmin, (req, res, next) => userController.create(req, res, next));
router.get('/:id', (req, res, next) => userController.getById(req, res, next));
router.put('/:id', requireAdmin, (req, res, next) => userController.update(req, res, next));
router.delete('/:id', requireAdmin, verifyPassword, (req, res, next) => userController.delete(req, res, next));

router.patch('/:id/password', (req, res, next) => userController.changePassword(req, res, next));
router.post('/:id/impersonate', requireSuperAdmin, (req, res, next) => userController.impersonate(req, res, next));

export default router;
