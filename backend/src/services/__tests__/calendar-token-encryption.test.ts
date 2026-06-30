/**
 * Tests for Google Calendar token encryption at rest (T-026)
 * ===========================================================
 *
 * Garante que:
 *  - Salvar tokens via OAuth callback chama prisma.update com payload `v1:...`
 *    (criptografado), nunca com o plaintext recebido do Google.
 *  - Leitura via syncWithGoogle descriptografa antes de usar como Bearer.
 *  - Refresh path persiste o NOVO accessToken criptografado.
 *  - Compat plaintext: tokens legados (sem prefixo `v1:`) ainda funcionam
 *    para leitura (decrypt retorna como-está).
 *
 * Mocks: prisma.googleCalendarToken + global.fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, isEncrypted, __resetKeyCache } from '../../utils/encryption';

const prismaMock = vi.hoisted(() => ({
  googleCalendarToken: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  calendarEvent: {
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  account: {
    findUnique: vi.fn(),
  },
}));

vi.mock('../../config/database', () => ({
  prisma: prismaMock,
}));

import { calendarService } from '../calendar.service';

const TEST_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('Google Calendar token encryption at rest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ENCRYPTION_KEY = TEST_KEY;
    __resetKeyCache();
    // Stub credenciais OAuth do account (env-based fallback ou DB).
    process.env.GOOGLE_CLIENT_ID = 'fake-client-id.apps.googleusercontent.com';
    process.env.GOOGLE_CLIENT_SECRET = 'fake-client-secret';
    process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
    // Conta sem credenciais DB → cai no fallback env (definido acima).
    prismaMock.account.findUnique.mockResolvedValue({
      googleClientId: null,
      googleClientSecret: null,
      googleRedirectUri: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('write path (OAuth callback)', () => {
    it('criptografa accessToken/refreshToken antes do upsert (nunca persiste plaintext)', async () => {
      const fakeAccess = 'ya29.PLAINTEXT_ACCESS_TOKEN_FROM_GOOGLE';
      const fakeRefresh = '1//PLAINTEXT_REFRESH_TOKEN_FROM_GOOGLE';

      // Mock do fetch: 1ª chamada = troca code→tokens, 2ª = userinfo
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: fakeAccess,
            refresh_token: fakeRefresh,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ email: 'user@example.com' }),
        });
      vi.stubGlobal('fetch', fetchMock);

      prismaMock.googleCalendarToken.upsert.mockResolvedValue({});

      // handleGoogleCallback(code, stateBase64) — decodifica accountId/userId
      // do state base64.
      const state = Buffer.from(
        JSON.stringify({ accountId: 'account-uuid', userId: 'user-uuid' })
      ).toString('base64');
      const result = await calendarService.handleGoogleCallback('fake-auth-code', state);

      expect(result.success).toBe(true);
      expect(prismaMock.googleCalendarToken.upsert).toHaveBeenCalledTimes(1);

      const call = prismaMock.googleCalendarToken.upsert.mock.calls[0][0];

      // CREATE path: tokens devem estar criptografados (prefixo v1:)
      expect(isEncrypted(call.create.accessToken)).toBe(true);
      expect(isEncrypted(call.create.refreshToken)).toBe(true);
      // E NÃO devem conter o plaintext original
      expect(call.create.accessToken).not.toContain(fakeAccess);
      expect(call.create.refreshToken).not.toContain(fakeRefresh);

      // UPDATE path idem
      expect(isEncrypted(call.update.accessToken)).toBe(true);
      expect(isEncrypted(call.update.refreshToken)).toBe(true);
      expect(call.update.accessToken).not.toContain(fakeAccess);
      expect(call.update.refreshToken).not.toContain(fakeRefresh);
    });
  });

  describe('read path (syncWithGoogle)', () => {
    it('descriptografa tokens v1: antes de enviar Bearer pro Google', async () => {
      const plainAccess = 'ya29.LIVE_ACCESS';
      const plainRefresh = '1//LIVE_REFRESH';

      prismaMock.googleCalendarToken.findUnique.mockResolvedValue({
        id: 'tk-1',
        accountId: 'acc-1',
        userId: 'usr-1',
        accessToken: encrypt(plainAccess),
        refreshToken: encrypt(plainRefresh),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000), // futuro → não refresh
        connectedEmail: 'a@b.com',
      });

      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await calendarService.syncWithGoogle('acc-1', 'usr-1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0];
      // Header Authorization deve carregar o plaintext decriptado, não o ciphertext
      expect(init.headers.Authorization).toBe(`Bearer ${plainAccess}`);
      expect(init.headers.Authorization).not.toContain('v1:');
    });

    it('compat: tokens legados em plaintext ainda funcionam (decrypt retorna como-está)', async () => {
      const plainAccess = 'ya29.LEGACY_PLAINTEXT_ACCESS';
      const plainRefresh = '1//LEGACY_PLAINTEXT_REFRESH';

      prismaMock.googleCalendarToken.findUnique.mockResolvedValue({
        id: 'tk-legacy',
        accountId: 'acc-1',
        userId: 'usr-1',
        accessToken: plainAccess,
        refreshToken: plainRefresh,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        connectedEmail: 'a@b.com',
      });

      const fetchMock = vi.fn().mockResolvedValueOnce({
        ok: true,
        json: async () => ({ items: [] }),
      });
      vi.stubGlobal('fetch', fetchMock);

      await calendarService.syncWithGoogle('acc-1', 'usr-1');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers.Authorization).toBe(`Bearer ${plainAccess}`);
    });
  });

  describe('refresh path', () => {
    it('persiste o novo accessToken criptografado quando renova', async () => {
      const expiredAccess = encrypt('ya29.OLD_EXPIRED');
      const refreshPlain = '1//REFRESH_LIVE';

      prismaMock.googleCalendarToken.findUnique.mockResolvedValue({
        id: 'tk-2',
        accountId: 'acc-2',
        userId: 'usr-2',
        accessToken: expiredAccess,
        refreshToken: encrypt(refreshPlain),
        expiresAt: new Date(Date.now() - 60 * 1000), // expirado
        connectedEmail: 'a@b.com',
      });
      prismaMock.googleCalendarToken.update.mockResolvedValue({});

      const newAccess = 'ya29.BRAND_NEW_ACCESS';
      const fetchMock = vi.fn()
        // 1) refresh token exchange
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            access_token: newAccess,
            expires_in: 3600,
          }),
        })
        // 2) events list
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ items: [] }),
        });
      vi.stubGlobal('fetch', fetchMock);

      await calendarService.syncWithGoogle('acc-2', 'usr-2');

      // O update do token deve persistir accessToken JÁ criptografado
      expect(prismaMock.googleCalendarToken.update).toHaveBeenCalled();
      const updateCall = prismaMock.googleCalendarToken.update.mock.calls[0][0];
      expect(isEncrypted(updateCall.data.accessToken)).toBe(true);
      expect(updateCall.data.accessToken).not.toContain(newAccess);

      // E o refresh foi enviado em plaintext pro Google (correto)
      const refreshFetchInit = fetchMock.mock.calls[0][1];
      expect(refreshFetchInit.body.toString()).toContain(encodeURIComponent(refreshPlain));
    });
  });
});
