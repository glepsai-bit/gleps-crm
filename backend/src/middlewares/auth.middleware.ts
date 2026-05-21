import { Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { AuthenticatedRequest, JwtPayload } from '../types';
import { UnauthorizedError, ForbiddenError, ErrorCodes } from '../utils/errors';
import { UserRole } from '@prisma/client';

/**
 * Middleware to authenticate JWT token
 */
export async function authenticate(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      throw new UnauthorizedError('Token não fornecido');
    }

    const token = authHeader.substring(7);

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtPayload;
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        throw new UnauthorizedError(ErrorCodes.TOKEN_EXPIRED);
      }
      throw new UnauthorizedError(ErrorCodes.TOKEN_INVALID);
    }

    // Fetch user from database to ensure they still exist and are active
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        account: true,
      },
    });

    if (!user) {
      throw new UnauthorizedError(ErrorCodes.USER_NOT_FOUND);
    }

    if (user.status !== 'active') {
      if (user.status === 'suspended') {
        throw new UnauthorizedError(ErrorCodes.USER_SUSPENDED);
      }
      throw new UnauthorizedError(ErrorCodes.USER_INACTIVE);
    }

    // Check account status (except for super_admin)
    if (user.role !== 'super_admin' && user.account) {
      if (user.account.status === 'paused') {
        throw new UnauthorizedError(ErrorCodes.ACCOUNT_PAUSED);
      }
    }

    // Set user in request
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      accountId: user.accountId,
      permissions: user.permissions,
      nome: user.nome,
      status: user.status,
    };

    // Set account in request if exists
    if (user.account) {
      req.account = {
        id: user.account.id,
        nome: user.account.nome,
        status: user.account.status,
        timezone: user.account.timezone,
        chatwootBaseUrl: (user.account as any).chatwootBaseUrl ?? null,
        chatwootAccountId: (user.account as any).chatwootAccountId ?? null,
        chatwootApiKey: (user.account as any).chatwootApiKey ?? null,
      };
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to require specific roles
 */
export function requireRole(...roles: UserRole[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenError(ErrorCodes.PERMISSION_DENIED));
    }

    next();
  };
}

/**
 * Middleware to require Super Admin role
 */
export function requireSuperAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError());
  }

  if (req.user.role !== 'super_admin') {
    return next(new ForbiddenError(ErrorCodes.SUPER_ADMIN_REQUIRED));
  }

  next();
}

/**
 * Middleware to require Admin role or higher
 */
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError());
  }

  if (!['super_admin', 'admin'].includes(req.user.role)) {
    return next(new ForbiddenError(ErrorCodes.ADMIN_REQUIRED));
  }

  next();
}

/**
 * Middleware to require specific permissions (for agents)
 */
export function requirePermission(...permissions: string[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedError());
    }

    // Super admin and admin have all permissions
    if (['super_admin', 'admin'].includes(req.user.role)) {
      return next();
    }

    // Check if agent has required permissions
    const hasPermission = permissions.some(p => req.user!.permissions.includes(p));

    if (!hasPermission) {
      return next(new ForbiddenError(ErrorCodes.PERMISSION_DENIED));
    }

    next();
  };
}

/**
 * Middleware to verify password for sensitive operations
 */
export async function verifyPassword(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Accept password from header (primary) or body (fallback)
    const password = (req.headers['x-confirm-password'] as string) || (req.body?.password as string);

    if (!password || !password.trim()) {
      // Use 400 (Bad Request) instead of 401 to avoid triggering global logout
      res.status(400).json({
        error: { code: 'PASSWORD_REQUIRED', message: 'Confirmação de senha requerida' },
      });
      return;
    }

    const bcrypt = await import('bcryptjs');

    const user = await prisma.user.findUnique({
      where: { id: req.user!.id },
      select: { passwordHash: true },
    });

    if (!user) {
      res.status(400).json({
        error: { code: 'USER_NOT_FOUND', message: 'Usuário não encontrado' },
      });
      return;
    }

    const isValid = await bcrypt.compare(password.trim(), user.passwordHash);

    if (!isValid) {
      // Use 403 (Forbidden) instead of 401 to avoid triggering global logout
      res.status(403).json({
        error: { code: 'PASSWORD_INVALID', message: 'Senha incorreta' },
      });
      return;
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to require accountId (blocks Super Admin without impersonation)
 */
export function requireAccountId(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError());
  }
  if (!req.user.accountId) {
    res.status(400).json({
      error: {
        code: 'ACCOUNT_REQUIRED',
        message: 'Esta operação requer uma conta vinculada.',
      },
    });
    return;
  }
  next();
}

/**
 * Middleware to ensure user can only access their own account's data
 */
export function requireSameAccount(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  if (!req.user) {
    return next(new UnauthorizedError());
  }

  // Super admin can access any account
  if (req.user.role === 'super_admin') {
    return next();
  }

  // Get accountId from route params or query
  const accountId = req.params.accountId || req.query.accountId as string;

  // If no accountId specified, allow (will use user's accountId)
  if (!accountId) {
    return next();
  }

  // Check if user belongs to the requested account
  if (req.user.accountId !== accountId) {
    return next(new ForbiddenError(ErrorCodes.PERMISSION_DENIED));
  }

  next();
}
