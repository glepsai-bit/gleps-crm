import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';
import { ValidationError } from '../utils/errors';

type ValidationTarget = 'body' | 'query' | 'params';

/**
 * Middleware factory for Zod schema validation
 */
export function validate(schema: ZodSchema, target: ValidationTarget = 'body') {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const data = req[target];
      const result = schema.safeParse(data);

      if (!result.success) {
        const errors = result.error.errors.reduce((acc, err) => {
          const path = err.path.join('.');
          acc[path] = err.message;
          return acc;
        }, {} as Record<string, string>);

        throw new ValidationError('Dados inválidos', errors);
      }

      // Replace with validated and transformed data
      req[target] = result.data;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Middleware factory for validating multiple targets
 */
export function validateMultiple(schemas: {
  body?: ZodSchema;
  query?: ZodSchema;
  params?: ZodSchema;
}) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      const errors: Record<string, string> = {};

      for (const [target, schema] of Object.entries(schemas)) {
        if (schema) {
          const data = req[target as ValidationTarget];
          const result = schema.safeParse(data);

          if (!result.success) {
            result.error.errors.forEach((err) => {
              const path = `${target}.${err.path.join('.')}`;
              errors[path] = err.message;
            });
          } else {
            req[target as ValidationTarget] = result.data;
          }
        }
      }

      if (Object.keys(errors).length > 0) {
        throw new ValidationError('Dados inválidos', errors);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Common validation schemas
 */
import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.string().transform(Number).pipe(z.number().min(1)).optional().default('1'),
  limit: z.string().transform(Number).pipe(z.number().min(1).max(100)).optional().default('20'),
});

export const sortSchema = z.object({
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export const dateRangeSchema = z.object({
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

export const uuidParamSchema = z.object({
  id: z.string().uuid('ID inválido'),
});

export const searchSchema = z.object({
  search: z.string().optional(),
});
