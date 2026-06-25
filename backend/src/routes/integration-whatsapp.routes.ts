import { Router } from 'express';
import { requireApiKey, requireScope } from '../middlewares/apiKey.middleware';
import { integrationWhatsappController } from '../controllers/integration-whatsapp.controller';

// ============================================
// T-022 — Integração WhatsApp (API key)
//
// Endpoint genérico de disparo (text/image/audio/document) para uso por
// integrações externas (n8n, agentes IA, ERPs como Pacto, webhooks de
// parceiros, etc).
//
// Mountar em '/integrations/whatsapp' (ver routes/index.ts):
//   POST /integrations/whatsapp/send
//
// Auth: x-api-key OU Authorization: Bearer <key>.
// Scope: 'messages:write' (ou '*'). Negar bots públicos sem permissão de
//        escrita evita exfiltração via key de leitura.
// ============================================

const router = Router();

router.use(requireApiKey);

router.post(
  '/send',
  requireScope('messages:write'),
  (req, res, next) => integrationWhatsappController.send(req, res, next)
);

export default router;
