/**
 * Attachment routes — Bug A (T-022) + PISTA D (upload multipart)
 *
 * GET /api/attachments/:id
 *   Streama a mídia anexada a uma Message. JWT obrigatório + RBAC por
 *   conta (controller valida que attachment pertence à accountId do usuário).
 *
 * POST /api/attachments/upload
 *   PISTA D — upload multipart dedicado pro composer (fluxo hibrido: base64
 *   ate 5MB, multipart >5MB ate 25MB). Grava buffer em disco, cria Attachment
 *   com messageId=null e retorna { id, fileUrl } pro proximo POST de message.
 *   Auth JWT + accountId (herdado do router.use). Limite 25MB por request
 *   (WhatsApp aceita ate ~16MB — folga cobre metadata + retry via multer).
 */

import { Router } from 'express';
import multer from 'multer';
import { attachmentController } from '../controllers/attachment.controller';
import { authenticate, requireAccountId } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticate);
router.use(requireAccountId);

// PISTA D — multer memoryStorage: valida limite antes de tocar em disco. O
// controller usa file.buffer diretamente. Aplicado APENAS na rota POST /upload
// (upload.single) — GET /:id nao passa por multer.
//
// limits.fileSize = 25MB: teto real do WhatsApp (~16MB) + folga. O composer
// ja bloqueia arquivo acima de 25MB antes de tentar o upload; multer serve
// como safety net e limita o consumo de RAM (memoryStorage aloca tudo em
// memoria) mesmo em requests forjadas.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

router.post('/upload', upload.single('file'), (req, res, next) =>
  attachmentController.upload(req, res, next)
);

router.get('/:id', (req, res, next) => attachmentController.stream(req, res, next));

export default router;
