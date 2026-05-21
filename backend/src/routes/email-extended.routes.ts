import { Router } from 'express';
import { campaignController } from '../controllers/campaign.controller';
import { inboxController } from '../controllers/inbox.controller';
import { authenticate, requirePermission, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// ==================== PUBLIC WEBHOOK (no auth) ====================
router.post('/inbound/webhook', (req, res, next) => inboxController.handleInboundWebhook(req, res, next));

// ==================== AUTHENTICATED ROUTES ====================
router.use(authenticate);
router.use(requireAccountId);

// Campaigns
router.get('/campaigns', requirePermission('emails'), (req, res, next) => campaignController.list(req, res, next));
router.post('/campaigns', requirePermission('emails'), (req, res, next) => campaignController.create(req, res, next));
router.get('/campaigns/:id', requirePermission('emails'), (req, res, next) => campaignController.get(req, res, next));
router.put('/campaigns/:id', requirePermission('emails'), (req, res, next) => campaignController.update(req, res, next));
router.delete('/campaigns/:id', requirePermission('emails'), (req, res, next) => campaignController.delete(req, res, next));
router.post('/campaigns/:id/cadences', requirePermission('emails'), (req, res, next) => campaignController.addCadence(req, res, next));
router.delete('/campaigns/:id/cadences', requirePermission('emails'), (req, res, next) => campaignController.removeCadence(req, res, next));
router.get('/campaigns/:id/stats', requirePermission('emails'), (req, res, next) => campaignController.getStats(req, res, next));
router.post('/campaigns/:id/dispatch-now', requirePermission('emails'), (req, res, next) => campaignController.dispatchNow(req, res, next));

// Inbox
router.get('/inbox', requirePermission('emails'), (req, res, next) => inboxController.listMessages(req, res, next));
router.get('/inbox/unread', requirePermission('emails'), (req, res, next) => inboxController.getUnreadCount(req, res, next));
router.get('/inbox/diagnostics', requirePermission('emails'), (req, res, next) => inboxController.getDiagnostics(req, res, next));
router.get('/inbox/:id', requirePermission('emails'), (req, res, next) => inboxController.getMessage(req, res, next));
router.put('/inbox/:id/read', requirePermission('emails'), (req, res, next) => inboxController.markRead(req, res, next));
router.put('/inbox/:id/replied', requirePermission('emails'), (req, res, next) => inboxController.markRepliedManually(req, res, next));
router.post('/inbox/:id/pause-enrollment', requirePermission('emails'), (req, res, next) => inboxController.pauseEnrollment(req, res, next));
router.post('/inbox/:id/resume-enrollment', requirePermission('emails'), (req, res, next) => inboxController.resumeEnrollment(req, res, next));
router.post('/inbox/:id/unenroll', requirePermission('emails'), (req, res, next) => inboxController.unenrollFromCadence(req, res, next));
router.post('/inbox/reply', requirePermission('emails'), (req, res, next) => inboxController.reply(req, res, next));
router.post('/inbox/suggest-reply', requirePermission('emails'), (req, res, next) => inboxController.suggestReply(req, res, next));

export default router;
