/**
 * T-039 — Fase 0 do Google Calendar no calendar.service.
 *
 * O que muda de verdade aqui: `invalid_grant` vira "reconecte" (409) em vez
 * de erro genérico, e é o ÚNICO caso que marca reauth — 500 do Google e
 * queda de rede não são revogação. O status lê o pedido de reconexão e o
 * escopo (não o vencimento do access token, que é de hora em hora e normal);
 * e o conflito local sabe que reserva vencida é horário livre.
 *
 * Sem Postgres: prisma e fetch mockados.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encrypt, isEncrypted } from '../utils/encryption';
import { AppError } from '../utils/errors';

const prismaMock = vi.hoisted(() => ({
  googleCalendarToken: { findUnique: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  calendarEvent: { findFirst: vi.fn(), create: vi.fn() },
  account: { findUnique: vi.fn() },
}));

vi.mock('../config/database', () => ({ prisma: prismaMock }));
vi.mock('./tracking.service', () => ({
  trackingService: {
    resolveCtwaForContact: vi.fn(async () => null),
    recordConversionEvent: vi.fn(async () => undefined),
  },
}));

import { calendarService, escopoPermiteEscrita } from './calendar.service';

const ACC = 'acc-1';
const USR = 'usr-1';
const PROF = 'prof-1';
const HORA = 60 * 60 * 1000;

const ESCOPO_ESCRITA =
  'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email';
const ESCOPO_LEITURA = 'https://www.googleapis.com/auth/calendar.readonly';

const tokenNoBanco = (over: Record<string, unknown> = {}) => ({
  id: 'tk-1',
  accountId: ACC,
  userId: USR,
  accessToken: encrypt('ya29.ACESSO'),
  refreshToken: encrypt('1//REFRESH'),
  expiresAt: new Date(Date.now() + HORA),
  connectedEmail: 'dra@clinica.com',
  calendarId: 'primary',
  scope: ESCOPO_ESCRITA,
  reauthRequiredAt: null,
  reauthReason: null,
  ...over,
});

const respostaHttp = (status: number, corpo: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => corpo,
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Credenciais OAuth vêm do env (conta sem nada no banco).
  process.env.GOOGLE_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.GOOGLE_CLIENT_SECRET = 'csecret';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
  prismaMock.account.findUnique.mockResolvedValue({
    googleClientId: null,
    googleClientSecret: null,
    googleRedirectUri: null,
  });
  prismaMock.googleCalendarToken.update.mockResolvedValue({});
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const dadosDoUpdate = (n = 0) => prismaMock.googleCalendarToken.update.mock.calls[n][0].data;

describe('accessTokenValido', () => {
  it('token longe de vencer volta descriptografado, sem ir ao Google', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco());

    await expect(calendarService.accessTokenValido(ACC, USR)).resolves.toBe('ya29.ACESSO');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sem token → GOOGLE_NAO_CONECTADO (409)', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(null);

    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_NAO_CONECTADO',
      statusCode: 409,
    });
  });

  it('token de outra conta é como se não existisse (multi-tenant)', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco({ accountId: 'outra' }));

    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_NAO_CONECTADO',
    });
  });

  it('token marcado pra reconectar é recusado antes de qualquer chamada', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(
      tokenNoBanco({ reauthRequiredAt: new Date(), reauthReason: 'invalid_grant' })
    );

    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
      statusCode: 409,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a menos de 60s de vencer, renova e persiste o novo token criptografado', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(
      tokenNoBanco({ expiresAt: new Date(Date.now() + 30_000) })
    );
    fetchMock.mockResolvedValueOnce(respostaHttp(200, { access_token: 'ya29.NOVO', expires_in: 3600 }));

    await expect(calendarService.accessTokenValido(ACC, USR)).resolves.toBe('ya29.NOVO');

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://oauth2.googleapis.com/token');
    expect(String(init.body)).toContain('grant_type=refresh_token');
    expect(isEncrypted(dadosDoUpdate().accessToken)).toBe(true);
  });

  it('forcarRenovacao renova mesmo com o banco dizendo que o token vale', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco());
    fetchMock.mockResolvedValueOnce(respostaHttp(200, { access_token: 'ya29.FORCADO', expires_in: 3600 }));

    await expect(
      calendarService.accessTokenValido(ACC, USR, { forcarRenovacao: true })
    ).resolves.toBe('ya29.FORCADO');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('conexão antiga sem refresh token, vencida → marca reauth (não tem como renovar)', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(
      tokenNoBanco({ refreshToken: '', expiresAt: new Date(Date.now() - 1000) })
    );

    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
    });
    expect(dadosDoUpdate()).toMatchObject({ reauthRequiredAt: expect.any(Date), reauthReason: 'sem refresh token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('refresh do token', () => {
  const tokenVencido = () => tokenNoBanco({ expiresAt: new Date(Date.now() - 1000) });

  it('invalid_grant marca reauth com o motivo do Google e lança 409 GOOGLE_REAUTH_REQUIRED', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenVencido());
    fetchMock.mockResolvedValueOnce(
      respostaHttp(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' })
    );

    const promessa = calendarService.accessTokenValido(ACC, USR);
    await expect(promessa).rejects.toBeInstanceOf(AppError);
    await expect(promessa).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
      statusCode: 409,
      message: 'Conexão com o Google expirou — reconecte a agenda',
    });

    expect(prismaMock.googleCalendarToken.update).toHaveBeenCalledTimes(1);
    expect(prismaMock.googleCalendarToken.update.mock.calls[0][0].where).toEqual({ userId: USR });
    expect(dadosDoUpdate()).toEqual({
      reauthRequiredAt: expect.any(Date),
      reauthReason: 'Token has been expired or revoked.',
    });
  });

  it('invalid_grant sem descrição guarda "invalid_grant"; descrição longa é cortada em 200', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenVencido());
    fetchMock.mockResolvedValueOnce(respostaHttp(400, { error: 'invalid_grant' }));
    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
    });
    expect(dadosDoUpdate(0).reauthReason).toBe('invalid_grant');

    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenVencido());
    fetchMock.mockResolvedValueOnce(
      respostaHttp(400, { error: 'invalid_grant', error_description: 'x'.repeat(300) })
    );
    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toMatchObject({
      code: 'GOOGLE_REAUTH_REQUIRED',
    });
    expect(dadosDoUpdate(1).reauthReason).toHaveLength(200);
  });

  it('500 do Google NÃO marca reauth — queda não é revogação', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenVencido());
    fetchMock.mockResolvedValueOnce(respostaHttp(500, { error: 'internal_failure' }));

    const promessa = calendarService.accessTokenValido(ACC, USR);
    await expect(promessa).rejects.toThrow('Falha ao renovar token do Google');
    await expect(promessa).rejects.not.toBeInstanceOf(AppError);
    expect(prismaMock.googleCalendarToken.update).not.toHaveBeenCalled();
  });

  it('corpo de erro que não é JSON também não marca reauth', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenVencido());
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('html');
      },
    });

    await expect(calendarService.accessTokenValido(ACC, USR)).rejects.toThrow('Falha ao renovar token do Google');
    expect(prismaMock.googleCalendarToken.update).not.toHaveBeenCalled();
  });
});

describe('getGoogleStatus', () => {
  it('needsReauth vem do reauthRequiredAt — access token vencido é normal', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(
      tokenNoBanco({ expiresAt: new Date(Date.now() - HORA) })
    );
    const status = await calendarService.getGoogleStatus(ACC, USR);
    expect(status).toMatchObject({ connected: true, needsReauth: false, reauthReason: null });

    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(
      tokenNoBanco({ reauthRequiredAt: new Date(), reauthReason: 'Token has been expired or revoked.' })
    );
    const marcado = await calendarService.getGoogleStatus(ACC, USR);
    expect(marcado).toMatchObject({
      connected: true,
      needsReauth: true,
      reauthReason: 'Token has been expired or revoked.',
    });
  });

  it('canWrite vem do escopo: token antigo só de leitura dá false', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco({ scope: ESCOPO_LEITURA }));
    expect((await calendarService.getGoogleStatus(ACC, USR)).canWrite).toBe(false);

    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco({ scope: ESCOPO_ESCRITA }));
    expect((await calendarService.getGoogleStatus(ACC, USR)).canWrite).toBe(true);

    // Token de antes da coluna existir: sem escopo guardado, não dá pra
    // prometer escrita.
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco({ scope: null }));
    expect((await calendarService.getGoogleStatus(ACC, USR)).canWrite).toBe(false);
  });

  it('mantém o formato antigo (email, expiresAt, source)', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(tokenNoBanco());
    const status = await calendarService.getGoogleStatus(ACC, USR);
    expect(status).toMatchObject({
      connected: true,
      configured: true,
      missing: [],
      email: 'dra@clinica.com',
      expiresAt: expect.any(Date),
      source: 'env',
    });
  });
});

describe('escopoPermiteEscrita', () => {
  it('só calendar.events ou calendar (completo) escrevem; qualquer readonly não', () => {
    expect(escopoPermiteEscrita(ESCOPO_ESCRITA)).toBe(true);
    expect(escopoPermiteEscrita('https://www.googleapis.com/auth/calendar')).toBe(true);
    expect(escopoPermiteEscrita(ESCOPO_LEITURA)).toBe(false);
    // "contém calendar.events" seria armadilha: este também contém.
    expect(escopoPermiteEscrita('https://www.googleapis.com/auth/calendar.events.readonly')).toBe(false);
    expect(escopoPermiteEscrita(null)).toBe(false);
    expect(escopoPermiteEscrita('')).toBe(false);
  });
});

describe('getGoogleAuthUrl', () => {
  it('pede escrita em eventos + e-mail, offline e com consent (pra vir refresh token)', async () => {
    const url = new URL(await calendarService.getGoogleAuthUrl(ACC, USR));
    const escopos = (url.searchParams.get('scope') ?? '').split(' ');

    expect(escopos).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(escopos).toContain('https://www.googleapis.com/auth/userinfo.email');
    expect(escopos).not.toContain(ESCOPO_LEITURA);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });
});

describe('handleGoogleCallback', () => {
  it('guarda o escopo que o Google concedeu e zera o pedido de reconexão', async () => {
    fetchMock
      .mockResolvedValueOnce(
        respostaHttp(200, {
          access_token: 'ya29.A',
          refresh_token: '1//R',
          expires_in: 3600,
          scope: ESCOPO_ESCRITA,
        })
      )
      .mockResolvedValueOnce(respostaHttp(200, { email: 'dra@clinica.com' }));
    prismaMock.googleCalendarToken.upsert.mockResolvedValue({});

    const state = Buffer.from(JSON.stringify({ accountId: ACC, userId: USR })).toString('base64');
    await calendarService.handleGoogleCallback('code', state);

    const { create, update } = prismaMock.googleCalendarToken.upsert.mock.calls[0][0];
    expect(create).toMatchObject({ scope: ESCOPO_ESCRITA, reauthRequiredAt: null, reauthReason: null });
    expect(update).toMatchObject({ scope: ESCOPO_ESCRITA, reauthRequiredAt: null, reauthReason: null });
  });
});

/**
 * Mini-avaliador do `where`: reproduz o que o Postgres faria com
 * lt/gt/not/OR pra ESTE filtro. O que está em teste é o filtro que o
 * service monta (status, hold vencido, meio-aberto), não o Prisma.
 */
interface EventoFixture {
  id: string;
  accountId: string;
  profissionalUserId: string;
  title: string;
  startTime: Date;
  endTime: Date;
  status: string;
  holdExpiresAt: Date | null;
}

/** O `where` que o service monta — o que o avaliador precisa entender. */
interface WhereConflito {
  accountId: string;
  profissionalUserId: string;
  startTime: { lt: Date };
  endTime: { gt: Date };
  id?: { not: string };
  OR: Array<{ status: string; holdExpiresAt?: { gt: Date } }>;
}

const aplicaWhere =
  (eventos: EventoFixture[]) =>
  ({ where }: { where: WhereConflito }) => {
    const casa = (ev: EventoFixture) =>
      ev.accountId === where.accountId &&
      ev.profissionalUserId === where.profissionalUserId &&
      ev.startTime < where.startTime.lt &&
      ev.endTime > where.endTime.gt &&
      (!where.id || ev.id !== where.id.not) &&
      where.OR.some(
        (o) =>
          ev.status === o.status &&
          (!o.holdExpiresAt || (ev.holdExpiresAt !== null && ev.holdExpiresAt > o.holdExpiresAt.gt))
      );
    const achado = eventos
      .filter(casa)
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0];
    return achado
      ? { id: achado.id, title: achado.title, startTime: achado.startTime, endTime: achado.endTime }
      : null;
  };

const as = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h, m));

describe('conflitoLocal', () => {
  const fixtures: EventoFixture[] = [
    { id: 'ev-marcado', accountId: ACC, profissionalUserId: PROF, title: 'Limpeza', startTime: as(14), endTime: as(15), status: 'scheduled', holdExpiresAt: null },
    { id: 'ev-hold-vencido', accountId: ACC, profissionalUserId: PROF, title: 'Reserva velha', startTime: as(15), endTime: as(16), status: 'held', holdExpiresAt: new Date(Date.now() - 60_000) },
    { id: 'ev-hold-vigente', accountId: ACC, profissionalUserId: PROF, title: 'Reserva', startTime: as(16), endTime: as(17), status: 'held', holdExpiresAt: new Date(Date.now() + 10 * 60_000) },
    { id: 'ev-cancelado', accountId: ACC, profissionalUserId: PROF, title: 'Desistiu', startTime: as(17), endTime: as(18), status: 'cancelled', holdExpiresAt: null },
    { id: 'ev-outra-prof', accountId: ACC, profissionalUserId: 'prof-2', title: 'Outra', startTime: as(14), endTime: as(15), status: 'scheduled', holdExpiresAt: null },
  ];

  beforeEach(() => {
    prismaMock.calendarEvent.findFirst.mockImplementation(aplicaWhere(fixtures));
  });

  it('pega o evento marcado que se sobrepõe', async () => {
    const conflito = await calendarService.conflitoLocal(ACC, PROF, as(14, 30), as(15, 30));
    expect(conflito).toMatchObject({ id: 'ev-marcado', title: 'Limpeza' });
  });

  it('hold vencido é horário livre; hold vigente ocupa', async () => {
    expect(await calendarService.conflitoLocal(ACC, PROF, as(15), as(16))).toBeNull();
    expect(await calendarService.conflitoLocal(ACC, PROF, as(16), as(16, 30))).toMatchObject({
      id: 'ev-hold-vigente',
    });
  });

  it('cancelado não ocupa', async () => {
    expect(await calendarService.conflitoLocal(ACC, PROF, as(17), as(18))).toBeNull();
  });

  it('encostar não conflita (intervalo meio-aberto)', async () => {
    expect(await calendarService.conflitoLocal(ACC, PROF, as(13), as(14))).toBeNull();
  });

  it('só olha o profissional pedido', async () => {
    expect(await calendarService.conflitoLocal(ACC, 'prof-3', as(14), as(15))).toBeNull();
  });

  it('ignorarEventoId deixa o próprio evento fora (remarcação)', async () => {
    expect(await calendarService.conflitoLocal(ACC, PROF, as(14), as(15), 'ev-marcado')).toBeNull();
  });

  it('a consulta é escopada por conta e usa o "agora" no corte do hold', async () => {
    const antes = Date.now();
    await calendarService.conflitoLocal(ACC, PROF, as(14), as(15));
    const { where } = prismaMock.calendarEvent.findFirst.mock.calls[0][0] as { where: WhereConflito };
    expect(where.accountId).toBe(ACC);
    expect(where.profissionalUserId).toBe(PROF);
    const held = where.OR.find((o) => o.status === 'held');
    expect(held?.holdExpiresAt?.gt.getTime()).toBeGreaterThanOrEqual(antes);
  });
});

describe('create com profissional', () => {
  it('horário ocupado → 409 HORARIO_OCUPADO e não grava', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue({
      id: 'ev-marcado',
      title: 'Limpeza',
      startTime: as(14),
      endTime: as(15),
    });

    await expect(
      calendarService.create({
        accountId: ACC,
        title: 'Avaliação',
        startTime: as(14, 30),
        endTime: as(15, 30),
        profissionalUserId: PROF,
      })
    ).rejects.toMatchObject({ code: 'HORARIO_OCUPADO', statusCode: 409 });

    expect(prismaMock.calendarEvent.create).not.toHaveBeenCalled();
  });

  it('sem profissional nem consulta conflito (evento solto do CRM segue livre)', async () => {
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'ev-novo' });

    await calendarService.create({ accountId: ACC, title: 'Reunião', startTime: as(14), endTime: as(15) });

    expect(prismaMock.calendarEvent.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.calendarEvent.create).toHaveBeenCalledTimes(1);
  });

  it('horário livre grava os campos novos (reserva com vencimento, vínculo, Google)', async () => {
    prismaMock.calendarEvent.findFirst.mockResolvedValue(null);
    prismaMock.calendarEvent.create.mockResolvedValue({ id: 'ev-novo' });
    const vence = new Date(Date.now() + 10 * 60_000);

    await calendarService.create({
      accountId: ACC,
      title: 'Avaliação',
      startTime: as(10),
      endTime: as(11),
      profissionalUserId: PROF,
      productId: 'prod-1',
      conversationId: 'conv-1',
      status: 'held',
      holdExpiresAt: vence,
      googleEventId: 'gev-1',
      googleCalendarId: 'primary',
      source: 'crm',
    });

    expect(prismaMock.calendarEvent.create.mock.calls[0][0].data).toMatchObject({
      accountId: ACC,
      profissionalUserId: PROF,
      productId: 'prod-1',
      conversationId: 'conv-1',
      status: 'held',
      holdExpiresAt: vence,
      googleEventId: 'gev-1',
      googleCalendarId: 'primary',
      source: 'crm',
    });
  });
});
