/**
 * ETAPA D — /api/disparos. Mesma guarda das rotas de dispatch antigas
 * (/dispatch, /whatsapp/campaigns): JWT + módulo "disparos" + admin/super_admin
 * + conta.
 */
import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { disparoController } from '../controllers/disparo.controller';
import { authenticate, requireAccountId, requireRole, requireModulo } from '../middlewares/auth.middleware';
import { LIMITE_MAXIMO_BYTES } from '../services/disparo-anexo.service';
import { ValidationError } from '../utils/errors';

const router = Router();

router.use(authenticate);
router.use(requireModulo('disparos'));
router.use(requireRole('super_admin', 'admin'));
router.use(requireAccountId);

// Anexo em memória: o buffer vai pro validador (magic bytes) e daí pro disco
// em uploads/disparos/<conta>/. O teto aqui é o maior dos limites (PDF, 5 MB);
// o limite por tipo é conferido no service.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIMITE_MAXIMO_BYTES, files: 1 },
});

/** Erro do multer vira 400 legível; sem isso "arquivo grande" cai como 500. */
function uploadDeAnexo(req: Request, res: Response, next: NextFunction): void {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('Arquivo maior que 5 MB. Imagem e áudio até 2 MB, PDF até 5 MB.'));
    }
    next(err);
  });
}

router.get('/', (req, res, next) => disparoController.listar(req, res, next));
router.get('/numeros', (req, res, next) => disparoController.numeros(req, res, next));
router.post('/preview-lista', (req, res, next) => disparoController.previewLista(req, res, next));
router.post('/variar', (req, res, next) => disparoController.variar(req, res, next));
router.post('/anexos', uploadDeAnexo, (req, res, next) => disparoController.anexo(req, res, next));
router.post('/', (req, res, next) => disparoController.criar(req, res, next));
router.get('/:id', (req, res, next) => disparoController.detalhe(req, res, next));
router.post('/:id/pausar', (req, res, next) => disparoController.pausar(req, res, next));
router.post('/:id/retomar', (req, res, next) => disparoController.retomar(req, res, next));
router.post('/:id/cancelar', (req, res, next) => disparoController.cancelar(req, res, next));
router.post('/:id/reenviar-nao-respondidos', (req, res, next) =>
  disparoController.reenviarNaoRespondidos(req, res, next)
);

export default router;
