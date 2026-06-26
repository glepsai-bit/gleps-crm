import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { isProduction } from '../config/env';

/**
 * H-CROSS-1c: remove paths absolutos (qualquer caminho POSIX/Win)
 * das mensagens/stacks que sao serializadas pro cliente em dev.
 * Mesmo em dev os erros vazavam o layout de pastas do dev — `/Users/…`,
 * `/home/…`, `/private/tmp/crm-fitpark/backend/…` —, o que e' info de
 * recon util. Substitui por marcadores genericos preservando o
 * nome do arquivo final pra ainda servir de pista de debug.
 */
const ABSOLUTE_PATH_REGEXES: Array<[RegExp, string]> = [
  // /private/tmp/.../crm-fitpark[/qualquer-coisa] -> <repo>
  [/(\/private)?\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*?\/crm-fitpark(?=\/|$)/g, '<repo>'],
  // /Users/<user>/...  -> /Users/<redacted>
  [/\/Users\/[A-Za-z0-9._-]+/g, '/Users/<redacted>'],
  // /home/<user>/...   -> /home/<redacted>
  [/\/home\/[A-Za-z0-9._-]+/g, '/home/<redacted>'],
  // C:\Users\<user>\...
  [/[A-Z]:\\Users\\[A-Za-z0-9._-]+/g, 'C:\\Users\\<redacted>'],
];

function sanitizePaths(input: string | undefined): string | undefined {
  if (!input) return input;
  let out = input;
  for (const [re, repl] of ABSOLUTE_PATH_REGEXES) {
    out = out.replace(re, repl);
  }
  return out;
}

export function errorHandler(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  // Log: downgrade auth errors (401/403) to warn to reduce noise
  const meta = { method: req.method, path: req.path, query: req.query, ip: req.ip };
  if (error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)) {
    logger.warn(`Auth error: ${error.message}`, { ...meta, code: error.code });
  } else {
    logger.error('Request error', error, meta);
  }

  // Handle AppError (our custom errors)
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
    return;
  }

  // Handle Zod validation errors
  // L-AUTH-1: além do shape legado `{ [field]: message }` (mantido em
  // `details` por compatibilidade com clientes antigos), incluímos
  // `fieldErrors: Array<{ field, message }>` para o frontend mapear erros
  // diretamente nos forms (react-hook-form). A mensagem geral também
  // referencia o primeiro campo inválido pra dar contexto quando a UI não
  // consegue (ou não quer) renderizar por campo.
  if (error instanceof ZodError) {
    const details = error.errors.reduce((acc, err) => {
      const path = err.path.join('.');
      acc[path] = err.message;
      return acc;
    }, {} as Record<string, string>);

    const fieldErrors = error.errors.map((err) => ({
      field: err.path.join('.'),
      message: err.message,
    }));

    const primary = fieldErrors[0];
    const message = primary
      ? `Dados inválidos: ${primary.field ? primary.field + ' — ' : ''}${primary.message}`
      : 'Dados inválidos';

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message,
        details,
        fieldErrors,
      },
    });
    return;
  }

  // Handle Prisma errors
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case 'P2002': {
        // Unique constraint violation
        const target = (error.meta?.target as string[])?.join(', ') || 'campo';
        res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: `Valor duplicado para: ${target}`,
            details: { field: target },
          },
        });
        return;
      }
      case 'P2003': {
        // Foreign key constraint violation
        res.status(400).json({
          error: {
            code: 'FOREIGN_KEY_ERROR',
            message: 'Referência a registro inexistente',
          },
        });
        return;
      }
      case 'P2025': {
        // Record not found
        res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Registro não encontrado',
          },
        });
        return;
      }
      default:
        break;
    }
  }

  if (error instanceof Prisma.PrismaClientValidationError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos para o banco de dados',
      },
    });
    return;
  }

  // Handle JWT errors
  if (error.name === 'JsonWebTokenError') {
    res.status(401).json({
      error: {
        code: 'INVALID_TOKEN',
        message: 'Token inválido',
      },
    });
    return;
  }

  if (error.name === 'TokenExpiredError') {
    res.status(401).json({
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Token expirado',
      },
    });
    return;
  }

  // Default error response.
  // H-CROSS-1c: em producao NUNCA inclui message original nem stack — so
  // mensagem generica + code. Em dev incluimos message+stack pra debug,
  // mas sanitizamos paths absolutos (regex acima) pra nao vazar layout
  // de pastas do dev nas respostas HTTP.
  if (isProduction) {
    res.status(500).json({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Erro interno do servidor',
      },
    });
    return;
  }

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: sanitizePaths(error.message) || 'Erro interno do servidor',
      stack: sanitizePaths(error.stack),
    },
  });
}

/**
 * Handle 404 errors for unknown routes
 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `Rota não encontrada: ${req.method} ${req.path}`,
    },
  });
}
