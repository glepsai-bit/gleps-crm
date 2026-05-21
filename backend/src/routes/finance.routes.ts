import { Router } from 'express';
import { financeController } from '../controllers/finance.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication and finance permission
router.use(authenticate, requirePermission('finance'));

router.get('/kpis', (req, res, next) => financeController.getKPIs(req, res, next));
router.get('/revenue-chart', (req, res, next) => financeController.getRevenueChart(req, res, next));
router.get('/payment-methods', (req, res, next) => financeController.getPaymentMethods(req, res, next));
router.get('/funnel-conversion', (req, res, next) => financeController.getFunnelConversion(req, res, next));

export default router;
