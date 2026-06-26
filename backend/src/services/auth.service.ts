import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { JwtPayload } from '../types';
import { UnauthorizedError, ErrorCodes, NotFoundError } from '../utils/errors';
import { getExpirationDate } from '../utils/helpers';
import { eventService } from './event.service';
import { v4 as uuidv4 } from 'uuid';
import { disconnectUserSockets } from '../socket';
import { logger } from '../utils/logger';

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
  };
  account: {
    id: string;
    nome: string;
    status: string;
    timezone: string;
  } | null;
  token: string;
  refreshToken: string;
  expiresAt: string;
}

export interface RefreshResult {
  token: string;
  expiresAt: string;
  refreshToken: string;
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

    // H-AUTH-1: timing attack mitigation.
    // Antes: se o e-mail nao existia, retornavamos imediato (~3ms) sem rodar bcrypt;
    // se existia mas a senha estava errada, rodavamos bcrypt (~280ms). Essa diferenca
    // permitia enumerar e-mails validos por timing. Agora sempre executamos bcrypt
    // contra um hash dummy quando o usuario nao existe, normalizando o tempo de
    // resposta entre os dois casos. A mensagem de erro tambem ja era generica
    // (INVALID_CREDENTIALS) para nao distinguir "usuario inexistente" vs "senha errada".
    const DUMMY_HASH = '$2a$10$CwTycUXWue0Thq9StjUM0uJ8R7yK6jyG7OQ1ezKZ4jKxLp9w2WJfO';
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const isPasswordValid = await bcrypt.compare(password, passwordHash);

    if (!user) {
      await eventService.create({
        eventType: 'auth.login.failed',
        payload: { email, reason: 'user_not_found', ip },
      });
      throw new UnauthorizedError(ErrorCodes.INVALID_CREDENTIALS);
    }

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
      },
      account: user.account ? {
        id: user.account.id,
        nome: user.account.nome,
        status: user.account.status,
        timezone: user.account.timezone,
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

    // H-AUTH-3: refresh token rotation.
    // Antes, o mesmo refresh token podia ser usado N vezes durante 7 dias —
    // se vazasse (xss, log, proxy), o atacante teria janela igual a vida
    // util restante. Agora cada uso ROTACIONA: emitimos um novo refresh
    // token e revogamos o antigo na mesma transaction (atomico). Se o
    // antigo for reusado depois, cai no branch revogado e devolve 401,
    // o que tambem permite detectar reuse no futuro.
    const newToken = uuidv4();
    const newExpiresAt = getExpirationDate(env.REFRESH_TOKEN_EXPIRES_IN);
    await prisma.$transaction([
      prisma.refreshToken.update({
        where: { id: refreshToken.id },
        data: { revokedAt: new Date() },
      }),
      prisma.refreshToken.create({
        data: {
          userId: refreshToken.userId,
          token: newToken,
          expiresAt: newExpiresAt,
        },
      }),
    ]);

    // Log event
    await eventService.create({
      eventType: 'auth.token.refresh',
      actorType: 'user',
      actorId: refreshToken.userId,
      accountId: refreshToken.user.accountId,
    });

    return { token, expiresAt, refreshToken: newToken };
  }

  /**
   * Logout user - revoke refresh token
   *
   * SE-H4: além de revogar o(s) refresh token(s), força a desconexão de
   * TODAS as sessões Socket.IO ativas desse usuário. Sem isso uma sessão
   * /chat aberta continua recebendo message:created e mention:new mesmo
   * após o logout, porque o middleware só valida o JWT no handshake.
   */
  async logout(userId: string, refreshTokenValue?: string): Promise<void> {
    if (refreshTokenValue) {
      // Revoke specific refresh token
      await prisma.refreshToken.updateMany({
        where: { userId, token: refreshTokenValue },
        data: { revokedAt: new Date() },
      });
    } else {
      // H-AUTH-2: antes, um logout sem refreshToken executava updateMany em
      // TODOS os refresh tokens ativos do usuario — derrubando qualquer outra
      // sessao em outro device/aba simultaneamente. Como nao conseguimos
      // identificar com seguranca "a sessao atual" sem o refresh, o
      // comportamento correto eh NAO revogar nada nesse caso e apenas logar
      // um warning para o cliente corrigir a chamada. O socket dessa sessao
      // ainda eh derrubado abaixo via disconnectUserSockets (best-effort).
      logger.warn('[auth] logout chamado sem refreshToken — nenhuma sessao revogada', { userId });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { accountId: true },
    });

    // Derruba sockets vivos (best-effort — não bloqueia logout se Socket.IO
    // ainda não tiver sido inicializado, ex.: em ambiente de teste).
    try {
      disconnectUserSockets(userId, 'LOGOUT');
    } catch {
      /* Socket.IO pode não estar inicializado em alguns contextos */
    }

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
      },
      account: user.account ? {
        id: user.account.id,
        nome: user.account.nome,
        status: user.account.status,
        timezone: user.account.timezone,
        plano: user.account.plano,
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
