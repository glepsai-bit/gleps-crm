import { Router } from 'express';
import { aiController } from '../controllers/ai.controller';
import { authenticate, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';

/**
 * T-027 Fase 1 — Atendimento IA (agentes + base de conhecimento).
 *
 * Todas as rotas exigem JWT + admin/super_admin + accountId. É configuração de
 * atendimento e consome a chave de IA da conta (custo real por chamada), então
 * não fica sob permissão granular de agente — mesmo critério de
 * /admin/integracoes, onde a chave é cadastrada.
 */

const router = Router();

router.use(authenticate);
router.use(requireAdmin);
router.use(requireAccountId);

router.get('/status', (req, res, next) => aiController.status(req, res, next));

// Agentes
router.get('/agents', (req, res, next) => aiController.listAgents(req, res, next));
router.post('/agents', (req, res, next) => aiController.createAgent(req, res, next));
router.get('/agents/:id', (req, res, next) => aiController.getAgent(req, res, next));
router.patch('/agents/:id', (req, res, next) => aiController.updateAgent(req, res, next));
router.delete('/agents/:id', (req, res, next) => aiController.deleteAgent(req, res, next));
router.post('/agents/:id/run', (req, res, next) => aiController.runAgent(req, res, next));

// Bases de conhecimento
router.get('/knowledge', (req, res, next) => aiController.listBases(req, res, next));
router.post('/knowledge', (req, res, next) => aiController.createBase(req, res, next));
router.patch('/knowledge/:id', (req, res, next) => aiController.updateBase(req, res, next));
router.delete('/knowledge/:id', (req, res, next) => aiController.deleteBase(req, res, next));
router.get('/knowledge/:baseId/search', (req, res, next) => aiController.searchBase(req, res, next));

// Documentos da base
router.get('/knowledge/:baseId/docs', (req, res, next) => aiController.listDocs(req, res, next));
router.post('/knowledge/:baseId/docs', (req, res, next) => aiController.createDoc(req, res, next));
router.patch('/knowledge/docs/:docId', (req, res, next) => aiController.updateDoc(req, res, next));
router.delete('/knowledge/docs/:docId', (req, res, next) => aiController.deleteDoc(req, res, next));
router.post('/knowledge/docs/:docId/reindex', (req, res, next) =>
  aiController.reindexDoc(req, res, next)
);

export default router;
