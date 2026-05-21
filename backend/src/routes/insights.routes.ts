import { Router } from 'express';
import { insightsController } from '../controllers/insights.controller';
import { authenticate, requirePermission } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication and insights permission
router.use(authenticate, requirePermission('insights'));

router.get('/kpis', (req, res, next) => insightsController.getKPIs(req, res, next));
router.get('/products', (req, res, next) => insightsController.getProductAnalysis(req, res, next));
router.get('/temporal', (req, res, next) => insightsController.getTemporalAnalysis(req, res, next));
router.get('/marketing', (req, res, next) => insightsController.getMarketingMetrics(req, res, next));
router.get('/payment-methods', (req, res, next) => insightsController.getPaymentMethodsAnalysis(req, res, next));
router.get('/automatic', (req, res, next) => insightsController.getAutomaticInsights(req, res, next));
router.get('/agents-ranking', (req, res, next) => insightsController.getAgentsRanking(req, res, next));

export default router;
