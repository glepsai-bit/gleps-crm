/**
 * ETAPA D — controller de /api/disparos. Zod completo aqui; regra de negócio
 * no disparo.service. Formas alinhadas com o front-D (07/10): resposta
 * sempre em `{ data }`.
 */
import { Response, NextFunction } from 'express';
import { z } from 'zod';
import { disparoService } from '../services/disparo.service';
import { disparoAnexoService } from '../services/disparo-anexo.service';
import { AuthenticatedRequest } from '../types';
import { ValidationError } from '../utils/errors';

const uuid = z.string().uuid();

const listaSchema = z.discriminatedUnion('tipo', [
  z.object({ tipo: z.literal('publico'), audienceId: uuid }),
  z.object({
    tipo: z.literal('leads'),
    etapaTagId: uuid.nullable().optional(),
    tagIds: z.array(uuid).max(50).nullable().optional(),
  }),
  z.object({
    tipo: z.literal('numeros'),
    linhas: z.array(z.string().max(200)).max(2000, 'No máximo 2000 linhas por disparo'),
    quantidade: z.number().int().nonnegative().optional(),
  }),
]);

const anexoSchema = z
  .object({
    id: z.string().max(300).optional(),
    path: z.string().max(300).optional(),
    tipo: z.enum(['imagem', 'pdf', 'audio']).optional(),
    nome: z.string().max(255).optional(),
    mime: z.string().max(100).optional(),
    tamanho: z.number().int().nonnegative().optional(),
  })
  .refine((a) => !!(a.id || a.path), 'Anexo sem referência: envie o arquivo de novo.');

// Texto puro: template de WhatsApp nunca tem HTML (mesma regra do
// whatsapp-template.controller).
const HTML_TAG_REGEX = /<[^>]+>/;
const textoSchema = z
  .string()
  .trim()
  .min(1, 'Escreva a mensagem do disparo.')
  .max(4096, 'A mensagem passa de 4096 caracteres.')
  .refine((v) => !HTML_TAG_REGEX.test(v), 'A mensagem não pode conter HTML.');

const criarSchema = z.object({
  nome: z.string().trim().max(120).optional().nullable(),
  texto: textoSchema,
  variantes: z.array(textoSchema).max(3, 'No máximo 3 variações').optional().nullable(),
  anexo: anexoSchema.optional().nullable(),
  lista: listaSchema,
  inboxIds: z.array(uuid).min(1, 'Escolha pelo menos um número.').max(20),
  atendeRespostas: z.enum(['agente', 'humano']).optional(),
  agendadoPara: z.string().datetime({ offset: true }).optional().nullable(),
});

const previewSchema = z.object({ lista: listaSchema });
const variarSchema = z.object({ texto: textoSchema });
const detalheQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  status: z
    .enum([
      'pendente', 'enviando', 'enviada', 'entregue', 'lida', 'respondeu', 'falhou',
      'pulado_optout', 'pulado_invalido', 'pulado_duplicado', 'cancelado',
    ])
    .optional(),
});
const numerosQuerySchema = z.object({ contatos: z.coerce.number().int().nonnegative().optional() });

function contaDe(req: AuthenticatedRequest): string {
  return req.user!.accountId as string;
}

export class DisparoController {
  /** GET /api/disparos */
  async listar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      res.json({ data: await disparoService.listar(contaDe(req)) });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/disparos/numeros?contatos=N */
  async numeros(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const q = numerosQuerySchema.parse(req.query ?? {});
      res.json({ data: await disparoService.numerosDisponiveis(contaDe(req), q.contatos ?? null) });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/preview-lista */
  async previewLista(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = previewSchema.parse(req.body ?? {});
      res.json({ data: await disparoService.previewLista(contaDe(req), body.lista) });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos */
  async criar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = criarSchema.parse(req.body ?? {});
      const disparo = await disparoService.criar(contaDe(req), req.user?.id ?? null, {
        nome: body.nome ?? null,
        texto: body.texto,
        variantes: body.variantes ?? [],
        anexo: body.anexo ?? null,
        lista: body.lista,
        inboxIds: body.inboxIds,
        atendeRespostas: body.atendeRespostas ?? 'agente',
        agendadoPara: body.agendadoPara ?? null,
      });
      res.status(201).json({ data: disparo });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/variar */
  async variar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const body = variarSchema.parse(req.body ?? {});
      const variantes = await disparoService.variarComIA(contaDe(req), body.texto);
      res.json({ data: { variantes } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/anexos (multipart, campo `file`) */
  async anexo(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const file = (req as unknown as { file?: Express.Multer.File }).file;
      if (!file) throw new ValidationError('Arquivo obrigatório (campo "file").');
      const salvo = await disparoAnexoService.salvar(contaDe(req), {
        buffer: file.buffer,
        mimetype: file.mimetype,
        originalname: file.originalname,
        size: file.size,
      });
      res.status(201).json({ data: { id: salvo.id, tipo: salvo.tipo, nome: salvo.nome, mime: salvo.mime, tamanho: salvo.tamanho } });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/disparos/:id?page=N&status=X */
  async detalhe(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const id = uuid.parse(req.params.id);
      const q = detalheQuerySchema.parse(req.query ?? {});
      res.json({ data: await disparoService.detalhe(contaDe(req), id, q.page ?? 1, q.status ?? null) });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/:id/pausar */
  async pausar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const disparo = await disparoService.pausar(contaDe(req), uuid.parse(req.params.id));
      res.json({ data: { disparo } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/:id/retomar */
  async retomar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const disparo = await disparoService.retomar(contaDe(req), uuid.parse(req.params.id));
      res.json({ data: { disparo } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/:id/cancelar */
  async cancelar(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const disparo = await disparoService.cancelar(contaDe(req), uuid.parse(req.params.id));
      res.json({ data: { disparo } });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/disparos/:id/reenviar-nao-respondidos */
  async reenviarNaoRespondidos(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
    try {
      const disparo = await disparoService.reenviarNaoRespondidos(contaDe(req), uuid.parse(req.params.id), req.user?.id ?? null);
      res.status(201).json({ data: { disparo } });
    } catch (err) {
      next(err);
    }
  }
}

export const disparoController = new DisparoController();
