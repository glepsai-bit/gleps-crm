import { Router } from 'express';
import { emailController, emailWebhookController } from '../controllers/email.controller';
import { authenticate, requirePermission, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// ==================== PUBLIC WEBHOOK (no auth) ====================
router.post('/webhook/sendgrid', (req, res, next) => emailWebhookController.handleSendgridWebhook(req, res, next));

// ==================== AUTHENTICATED ROUTES ====================
router.use(authenticate);
router.use(requireAccountId);

// Cadences
router.get('/cadences', requirePermission('emails'), (req, res, next) => emailController.listCadences(req, res, next));
router.post('/cadences', requirePermission('emails'), (req, res, next) => emailController.createCadence(req, res, next));
router.get('/cadences/:id', requirePermission('emails'), (req, res, next) => emailController.getCadence(req, res, next));
router.put('/cadences/:id', requirePermission('emails'), (req, res, next) => emailController.updateCadence(req, res, next));
router.delete('/cadences/:id', requirePermission('emails'), (req, res, next) => emailController.deleteCadence(req, res, next));

// Steps
router.get('/cadences/:id/steps', requirePermission('emails'), (req, res, next) => emailController.listSteps(req, res, next));
router.post('/cadences/:id/steps', requirePermission('emails'), (req, res, next) => emailController.createStep(req, res, next));
router.put('/steps/:id', requirePermission('emails'), (req, res, next) => emailController.updateStep(req, res, next));
router.delete('/steps/:id', requirePermission('emails'), (req, res, next) => emailController.deleteStep(req, res, next));

// Templates
router.get('/templates', requirePermission('emails'), (req, res, next) => emailController.listTemplates(req, res, next));
router.post('/templates', requirePermission('emails'), (req, res, next) => emailController.createTemplate(req, res, next));
router.put('/templates/:id', requirePermission('emails'), (req, res, next) => emailController.updateTemplate(req, res, next));
router.delete('/templates/:id', requirePermission('emails'), (req, res, next) => emailController.deleteTemplate(req, res, next));

// Enrollments
router.post('/enroll', requirePermission('emails'), (req, res, next) => emailController.enroll(req, res, next));
router.post('/unenroll', requirePermission('emails'), (req, res, next) => emailController.unenroll(req, res, next));
router.get('/enrollments', requirePermission('emails'), (req, res, next) => emailController.listEnrollments(req, res, next));

// Sends
router.get('/sends', requirePermission('emails'), (req, res, next) => emailController.listSends(req, res, next));
router.get('/sends/stats', requirePermission('emails'), (req, res, next) => emailController.getSendStats(req, res, next));

// Quota (mensal + diário)
router.get('/quota', requirePermission('emails'), (req, res, next) => emailController.getQuota(req, res, next));

// AI
router.post('/ai/generate', requirePermission('emails'), (req, res, next) => emailController.generateEmail(req, res, next));

// Settings
router.get('/settings', requirePermission('emails'), (req, res, next) => emailController.getSettings(req, res, next));
router.put('/settings', requirePermission('emails'), (req, res, next) => emailController.updateSettings(req, res, next));

// Processor
router.post('/process', requirePermission('emails'), (req, res, next) => emailController.processQueue(req, res, next));

// Cadence Rules (branching)
router.get('/cadences/:id/rules', requirePermission('emails'), (req, res, next) => emailController.listRules(req, res, next));
router.post('/cadences/:id/rules', requirePermission('emails'), (req, res, next) => emailController.createRule(req, res, next));
router.put('/rules/:id', requirePermission('emails'), (req, res, next) => emailController.updateRule(req, res, next));
router.delete('/rules/:id', requirePermission('emails'), (req, res, next) => emailController.deleteRule(req, res, next));

// Connection tests
router.post('/test-connection', requirePermission('emails'), (req, res, next) => emailController.testSendgrid(req, res, next));
router.post('/test-send', requirePermission('emails'), (req, res, next) => emailController.testSendEmail(req, res, next));
router.post('/test-openai', requirePermission('emails'), (req, res, next) => emailController.testOpenai(req, res, next));

// Search
router.get('/search', requirePermission('emails'), (req, res, next) => emailController.searchByEmail(req, res, next));

export default router;
