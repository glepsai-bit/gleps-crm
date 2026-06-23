import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../middlewares/auth.middleware';
import { requireApiKey } from '../middlewares/apiKey.middleware';
import { whatsappCampaignController } from '../controllers/whatsapp-campaign.controller';

// ============================================
// JWT Router — usuários autenticados via Bearer JWT
// ============================================
const jwtRouter = Router();
jwtRouter.use(authenticate);
jwtRouter.use(requireRole('super_admin', 'admin'));

jwtRouter.post('/send-single', (req, res, next) =>
  whatsappCampaignController.sendSingle(req, res, next)
);
jwtRouter.post('/send-batch', (req, res, next) =>
  whatsappCampaignController.sendBatch(req, res, next)
);
jwtRouter.get('/batches', (req, res, next) =>
  whatsappCampaignController.listBatches(req, res, next)
);
jwtRouter.get('/batches/:id', (req, res, next) =>
  whatsappCampaignController.getBatch(req, res, next)
);
jwtRouter.delete('/batches/:id', (req, res, next) =>
  whatsappCampaignController.cancelScheduled(req, res, next)
);

// ============================================
// API Key Router — integrações externas (n8n, etc) via x-api-key/Bearer
// ============================================
const apiKeyRouter = Router();
apiKeyRouter.use(requireApiKey);

apiKeyRouter.post('/send-single', (req, res, next) =>
  whatsappCampaignController.sendSingle(req, res, next)
);
apiKeyRouter.post('/send-batch', (req, res, next) =>
  whatsappCampaignController.sendBatch(req, res, next)
);
apiKeyRouter.get('/batches', (req, res, next) =>
  whatsappCampaignController.listBatches(req, res, next)
);
apiKeyRouter.get('/batches/:id', (req, res, next) =>
  whatsappCampaignController.getBatch(req, res, next)
);

export { jwtRouter, apiKeyRouter };
export default jwtRouter;
