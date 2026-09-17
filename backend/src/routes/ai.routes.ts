import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { aiController } from '../controllers/ai.controller';
import { authenticate, requireAdmin, requireAccountId } from '../middlewares/auth.middleware';
import { EXTENSOES_ACEITAS, extensaoDe } from '../services/knowledge.service';
import { ValidationError } from '../utils/errors';

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

// Upload de arquivo e importação por URL. memoryStorage porque o buffer vai
// direto pro extrator e nunca toca disco; 15 MB cobre qualquer PDF de texto —
// acima disso é imagem escaneada, que não seria lida mesmo.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (extensaoDe(file.originalname)) return cb(null, true);
    cb(
      new ValidationError(
        `Formato não aceito. Envie ${EXTENSOES_ACEITAS.join(', ')} (planilha: exporte como CSV).`
      )
    );
  },
});

/** Erro do multer vira 400 legível; sem isso "arquivo grande" cai como 500. */
function uploadDeDoc(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('Arquivo maior que 15 MB. Divida o material ou cole o texto.'));
    }
    next(err);
  });
}

// Caminho canônico (/bases) e alias no prefixo antigo (/knowledge), pra quem
// já consome a listagem em /knowledge/:baseId/docs não precisar trocar de base.
for (const prefixo of ['/bases', '/knowledge']) {
  router.post(`${prefixo}/:baseId/docs/upload`, uploadDeDoc, (req, res, next) =>
    aiController.uploadDoc(req, res, next)
  );
  router.post(`${prefixo}/:baseId/docs/url`, (req, res, next) =>
    aiController.importDocFromUrl(req, res, next)
  );
}

export default router;
