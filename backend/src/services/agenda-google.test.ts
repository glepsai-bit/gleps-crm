/**
 * T-039 — cliente do Google Calendar.
 *
 * O Google devolve muita coisa que não ocupa horário (cancelado, "disponível",
 * dia inteiro que precisa virar 00:00–24:00 no fuso certo) e responde erro
 * de três famílias: reconecte (401/403), espere (429/5xx) e já-não-existe
 * (404/410). Cada uma tem destino diferente no CRM, e é essa tradução que se
 * testa aqui — não o Google.
 *
 * Sem Postgres: prisma e fetch mockados; o token vem de um spy no
 * calendarService (o refresh tem teste próprio em calendar.google.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { AppError } from '../utils/errors';

const prismaMock = vi.hoisted(() => ({
  googleCalendarToken: { findUnique: vi.fn(), update: vi.fn() },
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

import { calendarService } from './calendar.service';
import { agendaGoogleService, meiaNoiteNoFuso } from './agenda-google.service';

const ACC = 'acc-1';
const USR = 'usr-1';
const TZ = 'America/Sao_Paulo';
const BASE = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

let fetchMock: ReturnType<typeof vi.fn>;
let tokenSpy: MockInstance<typeof calendarService.accessTokenValido>;

/** Resposta como o `http()` do serviço lê: status + text(). */
const resposta = (status: number, corpo?: unknown) => ({
  status,
  text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)),
});

const chamada = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n];
  return {
    url: String(url),
    init,
    body: init?.body ? JSON.parse(init.body) : undefined,
  };
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  tokenSpy = vi.spyOn(calendarService, 'accessTokenValido').mockResolvedValue('tok-1');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('estado', () => {
  it('sem token: desconectado, sem e-mail, sem escrita', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue(null);
    expect(await agendaGoogleService.estado(USR)).toEqual({
      conectado: false,
      email: null,
      podeEscrever: false,
      precisaReconectar: false,
      motivo: null,
    });
  });

  it('token antigo só de leitura e marcado pra reconectar', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue({
      connectedEmail: 'dra@clinica.com',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
      reauthRequiredAt: new Date(),
      reauthReason: 'Token has been expired or revoked.',
    });
    expect(await agendaGoogleService.estado(USR)).toEqual({
      conectado: true,
      email: 'dra@clinica.com',
      podeEscrever: false,
      precisaReconectar: true,
      motivo: 'Token has been expired or revoked.',
    });
  });

  it('token com escrita e em dia — e nunca vai ao Google', async () => {
    prismaMock.googleCalendarToken.findUnique.mockResolvedValue({
      connectedEmail: 'dra@clinica.com',
      scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/userinfo.email',
      reauthRequiredAt: null,
      reauthReason: null,
    });
    expect(await agendaGoogleService.estado(USR)).toMatchObject({
      conectado: true,
      podeEscrever: true,
      precisaReconectar: false,
      motivo: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tokenSpy).not.toHaveBeenCalled();
  });
});

describe('meiaNoiteNoFuso', () => {
  it('00:00 em São Paulo é 03:00Z; fuso desconhecido cai em UTC', () => {
    expect(meiaNoiteNoFuso('2026-10-01', TZ).toISOString()).toBe('2026-10-01T03:00:00.000Z');
    expect(meiaNoiteNoFuso('2026-10-01', 'UTC').toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(meiaNoiteNoFuso('2026-10-01', 'Marte/Olympus').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});

describe('listarOcupados', () => {
  const de = new Date('2026-10-01T00:00:00Z');
  const ate = new Date('2026-10-08T00:00:00Z');

  it('descarta cancelado e "disponível"; dia inteiro ocupa o dia todo no fuso do calendário', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, {
        timeZone: TZ,
        items: [
          {
            id: 'g-com-hora',
            status: 'confirmed',
            summary: 'Consulta',
            start: { dateTime: '2026-10-01T14:00:00-03:00' },
            end: { dateTime: '2026-10-01T15:00:00-03:00' },
          },
          {
            id: 'g-cancelado',
            status: 'cancelled',
            start: { dateTime: '2026-10-01T16:00:00-03:00' },
            end: { dateTime: '2026-10-01T17:00:00-03:00' },
          },
          {
            id: 'g-disponivel',
            status: 'confirmed',
            transparency: 'transparent',
            summary: 'Lembrete',
            start: { dateTime: '2026-10-01T18:00:00-03:00' },
            end: { dateTime: '2026-10-01T19:00:00-03:00' },
          },
          {
            id: 'g-dia-inteiro',
            status: 'confirmed',
            summary: 'Congresso',
            start: { date: '2026-10-02' },
            end: { date: '2026-10-03' },
          },
          { id: 'g-sem-horario', status: 'confirmed' },
        ],
      })
    );

    const ocupados = await agendaGoogleService.listarOcupados(ACC, USR, de, ate);

    expect(ocupados.map((o) => o.googleEventId)).toEqual(['g-com-hora', 'g-dia-inteiro']);
    expect(ocupados[0]).toEqual({
      googleEventId: 'g-com-hora',
      inicio: new Date('2026-10-01T17:00:00Z'),
      fim: new Date('2026-10-01T18:00:00Z'),
      titulo: 'Consulta',
    });
    // 00:00–24:00 do dia 2 em São Paulo (UTC-3).
    expect(ocupados[1].inicio.toISOString()).toBe('2026-10-02T03:00:00.000Z');
    expect(ocupados[1].fim.toISOString()).toBe('2026-10-03T03:00:00.000Z');

    const { url, init } = chamada();
    const params = new URL(url).searchParams;
    expect(url.startsWith(`${BASE}?`)).toBe(true);
    expect(params.get('timeMin')).toBe(de.toISOString());
    expect(params.get('timeMax')).toBe(ate.toISOString());
    expect(params.get('singleEvents')).toBe('true');
    expect(params.get('orderBy')).toBe('startTime');
    expect(params.get('maxResults')).toBe('250');
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe('Bearer tok-1');
    expect(tokenSpy).toHaveBeenCalledWith(ACC, USR, { forcarRenovacao: false });
  });

  it('dia inteiro sem fuso nenhum conta em UTC', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, {
        items: [{ id: 'g1', start: { date: '2026-10-02' }, end: { date: '2026-10-03' } }],
      })
    );
    const [ocupado] = await agendaGoogleService.listarOcupados(ACC, USR, de, ate);
    expect(ocupado.inicio.toISOString()).toBe('2026-10-02T00:00:00.000Z');
    expect(ocupado.fim.toISOString()).toBe('2026-10-03T00:00:00.000Z');
  });

  it('segue nextPageToken até acabar', async () => {
    fetchMock
      .mockResolvedValueOnce(
        resposta(200, {
          nextPageToken: 'p2',
          items: [{ id: 'g1', start: { dateTime: '2026-10-01T14:00:00Z' }, end: { dateTime: '2026-10-01T15:00:00Z' } }],
        })
      )
      .mockResolvedValueOnce(
        resposta(200, {
          items: [{ id: 'g2', start: { dateTime: '2026-10-02T14:00:00Z' }, end: { dateTime: '2026-10-02T15:00:00Z' } }],
        })
      );

    const ocupados = await agendaGoogleService.listarOcupados(ACC, USR, de, ate);

    expect(ocupados.map((o) => o.googleEventId)).toEqual(['g1', 'g2']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(chamada(0).url).searchParams.get('pageToken')).toBeNull();
    expect(new URL(chamada(1).url).searchParams.get('pageToken')).toBe('p2');
  });
});

describe('criarEvento', () => {
  const ev = {
    titulo: 'Avaliação — Maria',
    descricao: 'Marcado pelo WhatsApp',
    inicio: new Date('2026-10-01T17:00:00Z'),
    fim: new Date('2026-10-01T18:00:00Z'),
    timezone: TZ,
  };

  it('POST com summary/description e timeZone em start e end; devolve id e link', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, { id: 'gev-1', htmlLink: 'https://calendar.google.com/event?eid=1' })
    );

    const criado = await agendaGoogleService.criarEvento(ACC, USR, ev);

    expect(criado).toEqual({ googleEventId: 'gev-1', htmlLink: 'https://calendar.google.com/event?eid=1' });
    const { url, init, body } = chamada();
    expect(url).toBe(BASE);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(body).toEqual({
      summary: 'Avaliação — Maria',
      description: 'Marcado pelo WhatsApp',
      start: { dateTime: '2026-10-01T17:00:00.000Z', timeZone: TZ },
      end: { dateTime: '2026-10-01T18:00:00.000Z', timeZone: TZ },
    });
  });

  it('sem htmlLink devolve null; sem id é erro do Google', async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { id: 'gev-2' }));
    expect(await agendaGoogleService.criarEvento(ACC, USR, ev)).toEqual({ googleEventId: 'gev-2', htmlLink: null });

    fetchMock.mockResolvedValueOnce(resposta(200, {}));
    await expect(agendaGoogleService.criarEvento(ACC, USR, ev)).rejects.toMatchObject({ code: 'GOOGLE_ERRO' });
  });
});

describe('atualizarEvento', () => {
  const novo = { inicio: new Date('2026-10-02T17:00:00Z'), fim: new Date('2026-10-02T18:00:00Z'), timezone: TZ };

  it('PATCH só com start/end', async () => {
    fetchMock.mockResolvedValueOnce(resposta(200, { id: 'gev-1' }));

    await agendaGoogleService.atualizarEvento(ACC, USR, 'gev-1', novo);

    const { url, init, body } = chamada();
    expect(url).toBe(`${BASE}/gev-1`);
    expect(init.method).toBe('PATCH');
    expect(Object.keys(body).sort()).toEqual(['end', 'start']);
    expect(body.start).toEqual({ dateTime: '2026-10-02T17:00:00.000Z', timeZone: TZ });
  });

  it('evento apagado no Google (404/410) → GOOGLE_EVENTO_NAO_ENCONTRADO', async () => {
    fetchMock.mockResolvedValueOnce(resposta(404, { error: { code: 404, message: 'Not Found' } }));
    await expect(agendaGoogleService.atualizarEvento(ACC, USR, 'gev-x', novo)).rejects.toMatchObject({
      code: 'GOOGLE_EVENTO_NAO_ENCONTRADO',
      statusCode: 404,
    });
  });
});

describe('cancelarEvento', () => {
  it('DELETE; 204 sem corpo é sucesso', async () => {
    fetchMock.mockResolvedValueOnce(resposta(204));
    await expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).resolves.toBeUndefined();
    const { url, init } = chamada();
    expect(url).toBe(`${BASE}/gev-1`);
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('engole 404 e 410 — já não existir é o que se queria', async () => {
    fetchMock.mockResolvedValueOnce(resposta(404, { error: { code: 404, message: 'Not Found' } }));
    await expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(resposta(410, { error: { code: 410, message: 'Resource has been deleted' } }));
    await expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).resolves.toBeUndefined();
  });

  it('id com caractere especial vai codificado na URL', async () => {
    fetchMock.mockResolvedValueOnce(resposta(204));
    await agendaGoogleService.cancelarEvento(ACC, USR, 'a b/c');
    expect(chamada().url).toBe(`${BASE}/a%20b%2Fc`);
  });
});

describe('obterEvento', () => {
  it('404/410 → null', async () => {
    fetchMock.mockResolvedValueOnce(resposta(404, { error: { code: 404 } }));
    expect(await agendaGoogleService.obterEvento(ACC, USR, 'gev-1')).toBeNull();
    fetchMock.mockResolvedValueOnce(resposta(410, { error: { code: 410 } }));
    expect(await agendaGoogleService.obterEvento(ACC, USR, 'gev-1')).toBeNull();
  });

  it('cancelado volta com esse status (editado lá, vence)', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, {
        id: 'gev-1',
        status: 'cancelled',
        start: { dateTime: '2026-10-01T17:00:00Z' },
        end: { dateTime: '2026-10-01T18:00:00Z' },
      })
    );
    expect(await agendaGoogleService.obterEvento(ACC, USR, 'gev-1')).toEqual({
      inicio: new Date('2026-10-01T17:00:00Z'),
      fim: new Date('2026-10-01T18:00:00Z'),
      status: 'cancelled',
    });
  });

  it('confirmado e remarcado no Google traz o horário novo', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(200, {
        id: 'gev-1',
        status: 'confirmed',
        start: { dateTime: '2026-10-05T17:00:00Z' },
        end: { dateTime: '2026-10-05T18:00:00Z' },
      })
    );
    expect(await agendaGoogleService.obterEvento(ACC, USR, 'gev-1')).toMatchObject({
      inicio: new Date('2026-10-05T17:00:00Z'),
      status: 'confirmed',
    });
    expect(chamada().url).toBe(`${BASE}/gev-1`);
  });
});

describe('erros do Google', () => {
  const rejeita = (code: string, statusCode: number) =>
    expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).rejects.toMatchObject({ code, statusCode });

  it('401 renova à força uma vez; se insistir, GOOGLE_SEM_PERMISSAO', async () => {
    fetchMock.mockResolvedValueOnce(resposta(401, {})).mockResolvedValueOnce(resposta(401, {}));

    await rejeita('GOOGLE_SEM_PERMISSAO', 409);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(tokenSpy).toHaveBeenNthCalledWith(1, ACC, USR, { forcarRenovacao: false });
    expect(tokenSpy).toHaveBeenNthCalledWith(2, ACC, USR, { forcarRenovacao: true });
  });

  it('401 seguido de sucesso é sucesso (token revogado no meio da hora)', async () => {
    tokenSpy.mockResolvedValueOnce('tok-velho').mockResolvedValueOnce('tok-novo');
    fetchMock.mockResolvedValueOnce(resposta(401, {})).mockResolvedValueOnce(resposta(204));

    await expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).resolves.toBeUndefined();
    expect(chamada(0).init.headers.Authorization).toBe('Bearer tok-velho');
    expect(chamada(1).init.headers.Authorization).toBe('Bearer tok-novo');
  });

  it('403 insufficientPermissions → GOOGLE_SEM_PERMISSAO 409, com mensagem pra reconectar', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(403, {
        error: { code: 403, message: 'Insufficient Permission', errors: [{ reason: 'insufficientPermissions' }] },
      })
    );
    const promessa = agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1');
    await expect(promessa).rejects.toBeInstanceOf(AppError);
    await expect(promessa).rejects.toMatchObject({
      code: 'GOOGLE_SEM_PERMISSAO',
      statusCode: 409,
      message: expect.stringContaining('reconecte'),
    });
  });

  it('403 por escopo (formato novo, ACCESS_TOKEN_SCOPE_INSUFFICIENT) também é sem permissão', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(403, {
        error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
      })
    );
    await rejeita('GOOGLE_SEM_PERMISSAO', 409);
  });

  it('403 por cota (rateLimitExceeded) é "espera", não "reconecte"', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(403, { error: { code: 403, errors: [{ reason: 'rateLimitExceeded' }] } })
    );
    await rejeita('GOOGLE_INDISPONIVEL', 503);
  });

  it('429 e 5xx → GOOGLE_INDISPONIVEL 503', async () => {
    fetchMock.mockResolvedValueOnce(resposta(429, {}));
    await rejeita('GOOGLE_INDISPONIVEL', 503);
    fetchMock.mockResolvedValueOnce(resposta(503, {}));
    await rejeita('GOOGLE_INDISPONIVEL', 503);
    // Erro que vem em HTML (proxy do Google) não derruba a tradução.
    fetchMock.mockResolvedValueOnce({ status: 502, text: async () => '<html>Bad Gateway</html>' });
    await rejeita('GOOGLE_INDISPONIVEL', 503);
  });

  it('rede fora → 503', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await rejeita('GOOGLE_INDISPONIVEL', 503);
  });

  it('15s sem resposta aborta e vira 503', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );

    const promessa = agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1');
    const esperado = expect(promessa).rejects.toMatchObject({ code: 'GOOGLE_INDISPONIVEL' });
    // Deixa o token resolver e o fetch ser chamado antes de andar o relógio.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await esperado;
  });

  it('outro 4xx vira GOOGLE_ERRO 502 com a mensagem do Google', async () => {
    fetchMock.mockResolvedValueOnce(
      resposta(400, { error: { code: 400, message: 'Invalid start time' } })
    );
    await expect(agendaGoogleService.cancelarEvento(ACC, USR, 'gev-1')).rejects.toMatchObject({
      code: 'GOOGLE_ERRO',
      statusCode: 502,
      message: expect.stringContaining('Invalid start time'),
    });
  });

  it('erros do calendarService (não conectado / reconectar) passam direto, sem virar 503', async () => {
    tokenSpy.mockRejectedValueOnce(new AppError('Google Calendar não conectado', 409, 'GOOGLE_NAO_CONECTADO'));
    await rejeita('GOOGLE_NAO_CONECTADO', 409);
    expect(fetchMock).not.toHaveBeenCalled();

    tokenSpy.mockRejectedValueOnce(
      new AppError('Conexão com o Google expirou — reconecte a agenda', 409, 'GOOGLE_REAUTH_REQUIRED')
    );
    await rejeita('GOOGLE_REAUTH_REQUIRED', 409);
  });
});
