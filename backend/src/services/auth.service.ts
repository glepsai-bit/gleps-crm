import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { JwtPayload } from '../types';
import { UnauthorizedError, ErrorCodes, NotFoundError } from '../utils/errors';
import { getExpirationDate } from '../utils/helpers';
import { eventService } from './event.service';
import { v4 as uuidv4 } from 'uuid';

export interface LoginInput {
  email: string;
  password: string;
}

export interface LoginResult {
  user: {
    id: string;
    nome: string;
    email: string;
    role: string;
    permissions: string[];
    status: string;
    accountId: string | null;
    chatwootAgentId: number | null;
  };
  account: {
    id: string;
    nome: string;
    status: string;
    timezone: string;
    chatwootBaseUrl: string | null;
    chatwootAccountId: string | null;
    chatwootApiKey: string | null;
  } | null;
  token: string;
  refreshToken: string;
  expiresAt: string;
}

export interface RefreshResult {
  token: string;
  expiresAt: string;
}

class AuthService {
  /**
   * Authenticate user with email and password
   */
  async login(input: LoginInput, ip?: string, userAgent?: string): Promise<LoginResult> {
    const { email, password } = input;

    // Find user by email
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { account: true },
    });

    if (!user) {
      await eventService.create({
        eventType: 'auth.login.failed',
        payload: { email, reason: 'user_not_found', ip },
      });
      throw new UnauthorizedError(ErrorCodes.INVALID_CREDENTIALS);
    }

    // Verify password
    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      await eventService.create({
        eventType: 'auth.login.failed',
        actorType: 'user',
        actorId: user.id,
        accountId: user.accountId,
        payload: { email, reason: 'invalid_password', ip },
      });
      throw new UnauthorizedError(ErrorCodes.INVALID_CREDENTIALS);
    }

    // Check user status
    if (user.status === 'suspended') {
      await eventService.create({
        eventType: 'auth.login.failed',
        actorType: 'user',
        actorId: user.id,
        accountId: user.accountId,
        payload: { email, reason: 'user_suspended', ip },
      });
      throw new UnauthorizedError(ErrorCodes.USER_SUSPENDED);
    }

    if (user.status !== 'active') {
      await eventService.create({
        eventType: 'auth.login.failed',
        actorType: 'user',
        actorId: user.id,
        accountId: user.accountId,
        payload: { email, reason: 'user_inactive', ip },
      });
      throw new UnauthorizedError(ErrorCodes.USER_INACTIVE);
    }

    // Check account status (except super_admin)
    if (user.role !== 'super_admin' && user.account) {
      if (user.account.status === 'paused') {
        await eventService.create({
          eventType: 'auth.login.failed',
          actorType: 'user',
          actorId: user.id,
          accountId: user.accountId,
          payload: { email, reason: 'account_paused', ip },
        });
        throw new UnauthorizedError(ErrorCodes.ACCOUNT_PAUSED);
      }
    }

    // Generate tokens
    const { token, expiresAt } = this.generateAccessToken(user);
    const refreshToken = await this.generateRefreshToken(user.id);

    // Update last login
    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    // Log success event
    await eventService.create({
      eventType: 'auth.login.success',
      actorType: 'user',
      actorId: user.id,
      accountId: user.accountId,
      payload: { email, ip, userAgent },
    });

    return {
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        status: user.status,
        accountId: user.accountId,
        chatwootAgentId: user.chatwootAgentId,
      },
      account: user.account ? {
        id: user.account.id,
        nome: user.account.nome,
        status: user.account.status,
        timezone: user.account.timezone,
        chatwootBaseUrl: user.account.chatwootBaseUrl,
        chatwootAccountId: user.account.chatwootAccountId,
        chatwootApiKey: user.account.chatwootApiKey,
      } : null,
      token,
      refreshToken,
      expiresAt,
    };
  }

  /**
   * Refresh access token using refresh token
   */
  async refresh(refreshTokenValue: string): Promise<RefreshResult> {
    // Find refresh token
    const refreshToken = await prisma.refreshToken.findUnique({
      where: { token: refreshTokenValue },
      include: { user: true },
    });

    if (!refreshToken) {
      throw new UnauthorizedError(ErrorCodes.REFRESH_TOKEN_INVALID);
    }

    // Check if token is expired or revoked
    if (refreshToken.revokedAt || refreshToken.expiresAt < new Date()) {
      throw new UnauthorizedError(ErrorCodes.REFRESH_TOKEN_INVALID);
    }

    // Check user status
    if (refreshToken.user.status !== 'active') {
      throw new UnauthorizedError(ErrorCodes.USER_INACTIVE);
    }

    // Generate new access token
    const { token, expiresAt } = this.generateAccessToken(refreshToken.user);

    // Log event
    await eventService.create({
      eventType: 'auth.token.refresh',
      actorType: 'user',
      actorId: refreshToken.userId,
      accountId: refreshToken.user.accountId,
    });

    return { token, expiresAt };
  }

  /**
   * Logout user - revoke refresh token
   */
  async logout(userId: string, refreshTokenValue?: string): Promise<void> {
    if (refreshTokenValue) {
      // Revoke specific refresh token
      await prisma.refreshToken.updateMany({
        where: { userId, token: refreshTokenValue },
        data: { revokedAt: new Date() },
      });
    } else {
      // Revoke all refresh tokens
      await prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accountId: true },
    });

    await eventService.create({
      eventType: 'auth.logout',
      actorType: 'user',
      actorId: userId,
      accountId: user?.accountId,
    });
  }

  /**
   * Verify password for sensitive operations
   */
  async verifyPassword(userId: string, password: string): Promise<boolean> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });

    if (!user) {
      throw new NotFoundError('Usuário');
    }

    return bcrypt.compare(password, user.passwordHash);
  }

  /**
   * Get current user data
   */
  async getMe(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: { account: true },
    });

    if (!user) {
      throw new NotFoundError('Usuário');
    }

    return {
      user: {
        id: user.id,
        nome: user.nome,
        email: user.email,
        role: user.role,
        permissions: user.permissions,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        accountId: user.accountId,
        chatwootAgentId: user.chatwootAgentId,
      },
      account: user.account ? {
        id: user.account.id,
        nome: user.account.nome,
        status: user.account.status,
        timezone: user.account.timezone,
        plano: user.account.plano,
        chatwootBaseUrl: user.account.chatwootBaseUrl,
        chatwootAccountId: user.account.chatwootAccountId,
        chatwootApiKey: user.account.chatwootApiKey,
      } : null,
    };
  }

  /**
   * Hash password
   */
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, env.BCRYPT_SALT_ROUNDS);
  }

  /**
   * Generate JWT access token
   */
  private generateAccessToken(user: {
    id: string;
    email: string;
    role: string;
    accountId: string | null;
    permissions: string[];
  }): { token: string; expiresAt: string } {
    const expiresAt = getExpirationDate(env.JWT_EXPIRES_IN);

    const payload: Omit<JwtPayload, 'iat' | 'exp'> = {
      sub: user.id,
      email: user.email,
      role: user.role as any,
      accountId: user.accountId,
      permissions: user.permissions,
    };

    const token = jwt.sign(payload, env.JWT_SECRET, {
      expiresIn: env.JWT_EXPIRES_IN as any,
    });

    return { token, expiresAt: expiresAt.toISOString() };
  }

  /**
   * Generate refresh token
   */
  private async generateRefreshToken(userId: string): Promise<string> {
    const token = uuidv4();
    const expiresAt = getExpirationDate(env.REFRESH_TOKEN_EXPIRES_IN);

    await prisma.refreshToken.create({
      data: {
        userId,
        token,
        expiresAt,
      },
    });

    return token;
  }
}

export const authService = new AuthService();
