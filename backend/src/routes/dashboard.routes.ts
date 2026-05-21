import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { authenticate, requireSuperAdmin, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// All routes require authentication + accountId
router.use(authenticate);
router.use(requireAccountId);

router.get('/kpis', (req, res, next) => dashboardController.getKPIs(req, res, next));
router.get('/hourly-peak', (req, res, next) => dashboardController.getHourlyPeak(req, res, next));
router.get('/backlog', (req, res, next) => dashboardController.getBacklog(req, res, next));
router.get('/agents-performance', (req, res, next) => dashboardController.getAgentPerformance(req, res, next));
router.get('/ia-vs-human', (req, res, next) => dashboardController.getIAvsHuman(req, res, next));

export default router;

// Super Admin routes
export const adminRouter = Router();
adminRouter.use(authenticate, requireSuperAdmin);

adminRouter.get('/kpis', (req, res, next) => dashboardController.getSuperAdminKPIs(req, res, next));
adminRouter.get('/server-resources', (req, res, next) => dashboardController.getServerResources(req, res, next));
adminRouter.get('/consumption-history', (req, res, next) => dashboardController.getConsumptionHistory(req, res, next));
adminRouter.get('/weekly-consumption', (req, res, next) => dashboardController.getWeeklyConsumption(req, res, next));
