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

// L-VEN-2: stub explícito p/ CRUD de lançamentos. Responde 501 NOT_IMPLEMENTED
// até alguém realmente precisar do livro-caixa. Ver finance.service.ts.
router.post('/entries', (req, res, next) => financeController.createEntryStub(req, res, next));

export default router;
