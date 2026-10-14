import { Router } from 'express';
import { provisionarController } from '../controllers/provisionar.controller';
import { authenticate, requireSuperAdmin } from '../middlewares/auth.middleware';

/**
 * PROVISIONAMENTO DE AGENTE — `/api/admin/provisionar/*`.
 *
 * Super admin apenas: cria agente, base, serviços, agenda, etapas e fluxo NA
 * conta de um cliente. Admin comum da conta usa as telas de sempre. Sem
 * `requireAccountId` de propósito — o super admin não tem conta; ela vem no
 * corpo (POST) ou do próprio agente (`:agentId`).
 */

const router = Router();

router.use(authenticate, requireSuperAdmin);

// Literal antes da paramétrica.
router.get('/conversas-teste/:segmento', (req, res, next) => provisionarController.conversasTeste(req, res, next));

// ETAPA G — leituras/escrita por conta, para o kit não precisar logar com usuário da conta.
router.get('/conta/:accountId', (req, res, next) => provisionarController.conta(req, res, next));
router.put('/conta/:accountId/ia', (req, res, next) => provisionarController.salvarIa(req, res, next));

router.post('/agente', (req, res, next) => provisionarController.criar(req, res, next));
router.get('/agente/:agentId', (req, res, next) => provisionarController.obter(req, res, next));
router.put('/agente/:agentId', (req, res, next) => provisionarController.atualizar(req, res, next));
router.post('/agente/:agentId/reverter', (req, res, next) => provisionarController.reverter(req, res, next));
router.post('/agente/:agentId/publicar', (req, res, next) => provisionarController.publicar(req, res, next));
router.post('/agente/:agentId/simular', (req, res, next) => provisionarController.simular(req, res, next));

export default router;
