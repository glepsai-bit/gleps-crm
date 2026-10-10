import { Router } from 'express';
import { prospectingController } from '../controllers/prospecting.controller';
import { prospectingAudienceController } from '../controllers/prospecting-audience.controller';
import { authenticate, requireAccountId, requirePermission, requireModulo } from '../middlewares/auth.middleware';

// Extração (Google Maps via RapidAPI) + públicos salvos + uso do mês.
// O disparo que morava aqui (/dispatch, /cancel, /resume, /batches*, /inboxes)
// saiu na etapa C1 — quem dispara é o motor único em /api/disparos.

const router = Router();

// Módulo "extracao" (ETAPA A): conta sem ele toma 403 MODULO_DESLIGADO.
router.use(authenticate, requireModulo('extracao'), requireAccountId);
// AUDIT-RBAC-PROSPECCAO: o front oferece a permissão granular 'extracao'
// (AgenteFormDialog → "Prospecção") e libera /admin/extracao|/admin/prospeccao
// para agentes com ela, mas o backend estava requireRole('admin','super_admin')
// — todo agente com a permissão via a tela e tomava 403 em TODAS as chamadas.
// requirePermission já dá passe livre a admin/super_admin e exige 'extracao'
// para agentes, alinhando as duas pontas.
router.use(requirePermission('extracao'));

router.post('/extract', (req, res, next) => prospectingController.extractLeads(req, res, next));
router.get('/usage', (req, res, next) => prospectingController.getUsage(req, res, next));

// Saved audiences (públicos salvos)
router.get('/audiences', (req, res, next) => prospectingAudienceController.list(req, res, next));
router.post('/audiences', (req, res, next) => prospectingAudienceController.create(req, res, next));
router.get('/audiences/:id', (req, res, next) => prospectingAudienceController.getById(req, res, next));
router.delete('/audiences/:id', (req, res, next) => prospectingAudienceController.delete(req, res, next));

export default router;
