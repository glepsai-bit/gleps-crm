import { Router } from 'express';
import { saleController } from '../controllers/sale.controller';
import { authenticate, requirePermission, verifyPassword, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication + accountId
router.use(authenticate);
router.use(requireAccountId);

router.get('/', requirePermission('sales', 'finance'), (req, res, next) => saleController.list(req, res, next));
router.post('/', requirePermission('sales'), (req, res, next) => saleController.create(req, res, next));
router.get('/kpis', requirePermission('sales', 'finance'), (req, res, next) => saleController.getKPIs(req, res, next));
router.get('/audit-log', requirePermission('finance', 'refunds'), (req, res, next) => saleController.getAuditLog(req, res, next));

router.get('/:id', requirePermission('sales', 'finance'), (req, res, next) => saleController.getById(req, res, next));
router.patch('/:id/pay', requirePermission('sales'), (req, res, next) => saleController.markPaid(req, res, next));
router.post('/:id/refund', requirePermission('refunds'), verifyPassword, (req, res, next) => saleController.refund(req, res, next));
router.post('/:id/items/:itemId/refund', requirePermission('refunds'), verifyPassword, (req, res, next) => saleController.refundItem(req, res, next));

export default router;
