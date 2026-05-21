import { Router } from 'express';
import { chatwootController } from '../controllers/chatwoot.controller';
import { authenticate, requireRole, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

// ============================================
// Webhook (No JWT auth, validated by signature)
// ============================================
router.post('/webhook', (req, res, next) => chatwootController.handleWebhook(req, res, next));

// Public endpoint for external automation (n8n) to log resolutions.
// Optional shared-secret protection via header `x-webhook-secret` (CHATWOOT_WEBHOOK_SECRET).
router.post('/log-resolution', (req, res, next) => chatwootController.logResolution(req, res, next));

// ============================================
// Credential-based routes (no accountId needed)
// Super Admin can use these when creating new accounts
// ============================================
router.post('/test-connection', authenticate, requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.testConnectionWithCredentials(req, res, next));
router.post('/agents/fetch', authenticate, requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.fetchAgentsWithCredentials(req, res, next));

// ============================================
// All other routes require authentication + accountId
// ============================================
router.use(authenticate);
router.use(requireAccountId);

// ============================================
// Connection Testing (account-based)
// ============================================
router.get('/test-connection', (req, res, next) => chatwootController.testConnection(req, res, next));

// ============================================
// Agents (account-based)
// ============================================
router.get('/agents', (req, res, next) => chatwootController.getAgents(req, res, next));

// ============================================
// Inboxes
// ============================================
router.get('/inboxes', (req, res, next) => chatwootController.getInboxes(req, res, next));

// ============================================
// Labels
// ============================================
router.get('/labels', (req, res, next) => chatwootController.getLabels(req, res, next));
router.post('/labels', requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.createLabel(req, res, next));
router.patch('/labels/:labelId', requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.updateLabel(req, res, next));
router.delete('/labels/:labelId', requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.deleteLabel(req, res, next));

// ============================================
// Metrics
// ============================================
router.get('/metrics', (req, res, next) => chatwootController.getMetrics(req, res, next));
router.post('/metrics', (req, res, next) => chatwootController.getMetrics(req, res, next));
router.get('/metrics/agents', requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.getAgentMetrics(req, res, next));
router.get('/metrics/conversations', (req, res, next) => chatwootController.getConversationMetrics(req, res, next));

// ============================================
// Conversations
// ============================================
router.get('/conversations', (req, res, next) => chatwootController.getConversations(req, res, next));

// ============================================
// Sync
// ============================================
router.post('/sync-labels', requireRole('admin', 'super_admin'), (req, res, next) => chatwootController.syncLabels(req, res, next));
router.post('/sync', (req, res, next) => chatwootController.handleSync(req, res, next));

export default router;
