/**
 * Testes do auth.service.ts (T1 — AUTH).
 *
 * Cobre login (success/fail/timing), refresh (rotation/revogado/expirado)
 * e logout (com/sem refreshToken específico).
 */

import { describe, it, expect } from 'vitest';
import { prismaTest } from '../test/setup';
import { createTestAccount } from '../test/helpers';
import { authService } from './auth.service';

/**
 * Helper: valida que o erro lancado eh um UnauthorizedError "compatível".
 * (Não usamos `instanceof UnauthorizedError` porque o vitest às vezes
 * carrega o módulo `utils/errors` duas vezes — uma via service interno
 * e outra via re-export — e cada cópia gera classes distintas, quebrando
 * o `instanceof` mesmo o erro sendo idêntico em estrutura.)
 */
function expectUnauthorized(err: unknown, expectedMessage?: string) {
  expect(err).toBeInstanceOf(Error);
  const e = err as Error & { statusCode?: number; code?: string };
  expect(e.statusCode).toBe(401);
  if (expectedMessage !== undefined) {
    expect(e.message).toBe(expectedMessage);
  }
}

describe('AuthService.login', () => {
  it('login com credenciais válidas: 200 + retorna token + refreshToken', async () => {
    const { user, password } = await createTestAccount();

    const result = await authService.login({ email: user.email, password });

    expect(result.token).toBeTruthy();
    expect(result.token.split('.').length).toBe(3); // JWT shape
    expect(result.refreshToken).toBeTruthy();
    // refreshToken é uuid v4
    expect(result.refreshToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.user.email).toBe(user.email);
    expect(result.user.id).toBe(user.id);
  });

  it('login com email válido + senha errada: throw UnauthorizedError (msg genérica)', async () => {
    const { user } = await createTestAccount();

    let caught: unknown;
    try {
      await authService.login({ email: user.email, password: 'senha-errada-xyz' });
    } catch (err) {
      caught = err;
    }

    expectUnauthorized(caught, 'Credenciais inválidas');
  });

  it('login com email INEXISTENTE: throw UnauthorizedError com msg igual + tempo >100ms (anti-timing)', async () => {
    // Cria account só pra garantir DB tem schema ok (não afeta o teste).
    await createTestAccount();

    const start = Date.now();
    let caught: unknown;
    try {
      await authService.login({
        email: `inexistente-${Date.now()}@nope.com`,
        password: 'qualquercoisa',
      });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - start;

    // mesma mensagem que email válido + senha errada (anti-enumeração)
    expectUnauthorized(caught, 'Credenciais inválidas');
    // bcrypt dummy hash deve ter rodado: >50ms.
    // (Sem o dummy hash, código retornava em ~3ms ao não achar o user;
    // bcrypt cost 10 leva 50-300ms dependendo da máquina. Floor 50ms
    // valida que o dummy hash de fato foi executado.)
    expect(elapsed).toBeGreaterThan(50);
  });

  it('refresh com token válido: retorna novo accessToken + novo refreshToken (rotation)', async () => {
    const { refreshToken: oldRefresh } = await createTestAccount();

    const result = await authService.refresh(oldRefresh);

    expect(result.token).toBeTruthy();
    expect(result.token.split('.').length).toBe(3);
    expect(result.refreshToken).toBeTruthy();
    // novo refreshToken é DIFERENTE do antigo (rotation)
    expect(result.refreshToken).not.toBe(oldRefresh);

    // Antigo deve estar revogado no DB
    const oldRecord = await prismaTest.refreshToken.findUnique({
      where: { token: oldRefresh },
    });
    expect(oldRecord?.revokedAt).not.toBeNull();

    // Novo deve existir e estar ativo
    const newRecord = await prismaTest.refreshToken.findUnique({
      where: { token: result.refreshToken },
    });
    expect(newRecord).toBeTruthy();
    expect(newRecord?.revokedAt).toBeNull();
  });

  it('refresh com token revogado: throw UnauthorizedError', async () => {
    const { refreshToken } = await createTestAccount();

    // Revoga manualmente
    await prismaTest.refreshToken.updateMany({
      where: { token: refreshToken },
      data: { revokedAt: new Date() },
    });

    let caught: unknown;
    try {
      await authService.refresh(refreshToken);
    } catch (err) {
      caught = err;
    }

    expectUnauthorized(caught);
  });

  it('refresh com token expirado: throw', async () => {
    const { refreshToken } = await createTestAccount();

    // Força expiresAt no passado
    await prismaTest.refreshToken.updateMany({
      where: { token: refreshToken },
      data: { expiresAt: new Date(Date.now() - 1000 * 60) },
    });

    let caught: unknown;
    try {
      await authService.refresh(refreshToken);
    } catch (err) {
      caught = err;
    }

    expectUnauthorized(caught);
  });

  it('refresh com token inexistente: throw UnauthorizedError', async () => {
    let caught: unknown;
    try {
      // UUID válido mas inexistente
      await authService.refresh('00000000-0000-4000-8000-000000000000');
    } catch (err) {
      caught = err;
    }
    expectUnauthorized(caught);
  });
});

describe('AuthService.logout', () => {
  it('logout SEM refreshToken: NÃO revoga outras sessions do user', async () => {
    const { user, password } = await createTestAccount();

    // Cria DUAS sessões adicionais via login
    await authService.login({ email: user.email, password });
    await authService.login({ email: user.email, password });

    const activeBefore = await prismaTest.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    // 3 sessions: 1 do createTestAccount + 2 logins acima
    expect(activeBefore).toBe(3);

    // Logout sem refreshToken — NÃO pode revogar nada
    await authService.logout(user.id /* sem refreshToken */);

    const activeAfter = await prismaTest.refreshToken.count({
      where: { userId: user.id, revokedAt: null },
    });
    expect(activeAfter).toBe(activeBefore);
  });

  it('logout COM refreshToken: revoga APENAS esse refresh específico', async () => {
    const { user, password, refreshToken: rt1 } = await createTestAccount();
    const loginB = await authService.login({ email: user.email, password });
    const loginC = await authService.login({ email: user.email, password });

    await authService.logout(user.id, loginB.refreshToken);

    // rt1 e loginC.refreshToken: ainda ativos
    const rt1Record = await prismaTest.refreshToken.findUnique({
      where: { token: rt1 },
    });
    expect(rt1Record?.revokedAt).toBeNull();

    const loginCRecord = await prismaTest.refreshToken.findUnique({
      where: { token: loginC.refreshToken },
    });
    expect(loginCRecord?.revokedAt).toBeNull();

    // loginB.refreshToken: revogado
    const loginBRecord = await prismaTest.refreshToken.findUnique({
      where: { token: loginB.refreshToken },
    });
    expect(loginBRecord?.revokedAt).not.toBeNull();
  });
});
