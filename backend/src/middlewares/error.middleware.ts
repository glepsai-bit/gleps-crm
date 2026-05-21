import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { isProduction } from '../config/env';

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
  if (error instanceof ZodError) {
    const details = error.errors.reduce((acc, err) => {
      const path = err.path.join('.');
      acc[path] = err.message;
      return acc;
    }, {} as Record<string, string>);

    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        details,
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

  // Default error response
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: isProduction ? 'Erro interno do servidor' : error.message,
      ...(isProduction ? {} : { stack: error.stack }),
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
