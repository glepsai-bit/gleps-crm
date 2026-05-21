import { Router } from 'express';
import { productController } from '../controllers/product.controller';
import { authenticate, requirePermission, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication + accountId
router.use(authenticate);
router.use(requireAccountId);

router.get('/', requirePermission('products', 'sales'), (req, res, next) => productController.list(req, res, next));
router.post('/', requirePermission('products'), (req, res, next) => productController.create(req, res, next));
router.get('/:id', requirePermission('products', 'sales'), (req, res, next) => productController.getById(req, res, next));
router.put('/:id', requirePermission('products'), (req, res, next) => productController.update(req, res, next));
router.delete('/:id', requireAdmin, (req, res, next) => productController.delete(req, res, next));

router.patch('/:id/status', requirePermission('products'), (req, res, next) => productController.toggleStatus(req, res, next));

export default router;
