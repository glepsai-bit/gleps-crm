/**
 * Marketing API (insights / metadados / diagnóstico).
 *
 * O ponto central destes testes: a versão anterior ENGOLIA o erro da Meta e
 * devolvia lista vazia, o que fazia a tela dizer "conecte a conta de anúncios"
 * mesmo com a conta conectada. Erro engolido = usuário sem diagnóstico.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metaCapiService } from './meta-capi.service';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const errJson = (status: number, message: string) => ({
  ok: false,
  status,
  json: async () => ({ error: { message } }),
});

describe('metaCapiService.getAdInsights', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('propaga o erro da Meta em vez de engolir', async () => {
    fetchMock.mockResolvedValue(
      errJson(400, '(#200) Requires ads_read permission to manage the object')
    );

    const res = await metaCapiService.getAdInsights('tok', 'act_1', '2026-08-01', '2026-08-10');

    expect(res.rows).toEqual([]);
    expect(res.error).toContain('ads_read');
  });

  it('normaliza o id da conta (aceita com e sem act_)', async () => {
    fetchMock.mockResolvedValue(okJson({ data: [] }));

    await metaCapiService.getAdInsights('tok', '204420430605741', '2026-08-01', '2026-08-10');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('/act_204420430605741/insights');
  });

  it('daily=true pede time_increment e devolve a data de cada linha', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        data: [
          {
            ad_id: 'a1',
            ad_name: 'Anúncio 1',
            campaign_id: 'c1',
            campaign_name: 'Campanha 1',
            spend: '16.67',
            impressions: '1200',
            inline_link_clicks: '30',
            date_start: '2026-08-09',
          },
        ],
      })
    );

    const res = await metaCapiService.getAdInsights(
      'tok',
      'act_1',
      '2026-08-01',
      '2026-08-10',
      { daily: true }
    );

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('time_increment=1');
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({
      adId: 'a1',
      campaignName: 'Campanha 1',
      spend: 16.67,
      impressions: 1200,
      linkClicks: 30,
      date: '2026-08-09',
    });
  });

  it('segue a paginação e acumula as páginas', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          data: [{ ad_id: 'a1', spend: '10' }],
          paging: { next: 'https://graph.facebook.com/v21.0/act_1/insights?after=X' },
        })
      )
      .mockResolvedValueOnce(okJson({ data: [{ ad_id: 'a2', spend: '5' }] }));

    const res = await metaCapiService.getAdInsights('tok', 'act_1', '2026-08-01', '2026-08-10');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.rows.map((r) => r.adId)).toEqual(['a1', 'a2']);
    expect(res.error).toBeNull();
  });

  it('erro no meio da paginação preserva o que já veio', async () => {
    fetchMock
      .mockResolvedValueOnce(
        okJson({
          data: [{ ad_id: 'a1', spend: '10' }],
          paging: { next: 'https://graph.facebook.com/v21.0/act_1/insights?after=X' },
        })
      )
      .mockResolvedValueOnce(errJson(500, 'temporário'));

    const res = await metaCapiService.getAdInsights('tok', 'act_1', '2026-08-01', '2026-08-10');

    expect(res.rows).toHaveLength(1);
    expect(res.error).toContain('temporário');
  });
});

describe('metaCapiService.getAdMeta', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('resolve nome do anúncio e da campanha por id', async () => {
    fetchMock.mockResolvedValue(
      okJson({
        a1: { id: 'a1', name: 'Anúncio A', campaign: { id: 'c1', name: 'Campanha X' } },
        a2: { id: 'a2', name: 'Anúncio B', campaign: { id: 'c1', name: 'Campanha X' } },
      })
    );

    const map = await metaCapiService.getAdMeta('tok', ['a1', 'a2', 'a1']);

    // ids repetidos viram uma consulta só
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('ids=a1%2Ca2');
    expect(map.get('a1')?.adName).toBe('Anúncio A');
    expect(map.get('a2')?.campaignName).toBe('Campanha X');
  });

  it('lista vazia não chama a Graph API', async () => {
    const map = await metaCapiService.getAdMeta('tok', []);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(map.size).toBe(0);
  });

  it('falha da API não derruba o funil — devolve mapa vazio', async () => {
    fetchMock.mockResolvedValue(errJson(400, 'nope'));
    const map = await metaCapiService.getAdMeta('tok', ['a1']);
    expect(map.size).toBe(0);
  });
});

describe('metaCapiService.checkConnection', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  /** O check de token sempre roda primeiro: /me + /debug_token. */
  const mockTokenOk = (scopes = ['ads_read', 'ads_management', 'business_management']) =>
    fetchMock
      .mockResolvedValueOnce(okJson({ id: 'su1', name: 'Sistema GLEPS' }))
      .mockResolvedValueOnce(
        okJson({ data: { application: 'CRM', expires_at: 0, scopes, is_valid: true } })
      );

  it('aponta o ativo exato que falhou, com o motivo da Meta', async () => {
    mockTokenOk()
      // pixel OK
      .mockResolvedValueOnce(okJson({ id: 'px1', name: 'Dataset WhatsApp' }))
      // conta de anúncios sem permissão
      .mockResolvedValueOnce(errJson(403, 'Ad account owner has NOT grant ads_management'));

    const checks = await metaCapiService.checkConnection('tok', 'px1', 'act_1');

    expect(checks).toHaveLength(3);
    expect(checks[0]).toMatchObject({ key: 'token', ok: true });
    expect(checks[1]).toMatchObject({ key: 'pixel', ok: true });
    expect(checks[1].detail).toContain('Dataset WhatsApp');
    expect(checks[2]).toMatchObject({ key: 'adAccount', ok: false });
    expect(checks[2].detail).toContain('ads_management');
    expect(checks[2].hint).toBeTruthy();
  });

  it('token válido mostra app, validade e escopos reais', async () => {
    mockTokenOk();
    const checks = await metaCapiService.checkConnection('tok', null, null);

    expect(checks[0].detail).toContain('Sistema GLEPS');
    expect(checks[0].detail).toContain('não expira');
    expect(checks[0].detail).toContain('ads_read');
    expect(checks[0].hint).toBeNull();
  });

  it('token sem ads_read é sinalizado mesmo com o app tendo a permissão', async () => {
    mockTokenOk(['business_management', 'pages_show_list']);
    const checks = await metaCapiService.checkConnection('tok', null, null);

    expect(checks[0].ok).toBe(true);
    expect(checks[0].hint).toContain('ads_read');
  });

  it('token que nem faz /me reprova sem culpar os ativos', async () => {
    fetchMock.mockResolvedValueOnce(errJson(400, 'Error validating access token: session has expired'));

    const checks = await metaCapiService.checkConnection('tok', null, null);

    expect(checks[0]).toMatchObject({ key: 'token', ok: false });
    expect(checks[0].hint).toContain('novo token');
    // /debug_token não é chamado quando /me já falhou
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('app bloqueado manda resolver o app, não atribuir o ativo', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({
        error: { message: 'API access blocked.', code: 10, error_subcode: 2332002, fbtrace_id: 'Ax1' },
      }),
    });

    const checks = await metaCapiService.checkConnection('tok', 'px1', 'act_1');

    expect(checks[0]).toMatchObject({ key: 'token', ok: false });
    expect(checks[0].detail).toContain('código 10');
    expect(checks[0].detail).toContain('trace Ax1');
    for (const c of checks) {
      expect(c.hint).toContain('Ações necessárias');
      expect(c.hint).not.toContain('atribua essa fonte de dados');
    }
  });

  it('sem pixel nem conta informados, os ativos reprovam sem chamar a API', async () => {
    mockTokenOk();
    const checks = await metaCapiService.checkConnection('tok', null, null);
    // só as 2 chamadas do check de token
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(checks.map((c) => c.ok)).toEqual([true, false, false]);
  });

  it('com período, inclui o check de leitura de investimento', async () => {
    mockTokenOk()
      .mockResolvedValueOnce(okJson({ id: 'px1', name: 'DS' }))
      .mockResolvedValueOnce(okJson({ id: 'act_1', name: 'Conta', currency: 'BRL' }))
      .mockResolvedValueOnce(okJson({ data: [{ ad_id: 'a1', spend: '10' }] }));

    const checks = await metaCapiService.checkConnection('tok', 'px1', 'act_1', {
      since: '2026-08-01',
      until: '2026-08-10',
    });

    expect(checks).toHaveLength(4);
    expect(checks[2].detail).toContain('BRL');
    expect(checks[3]).toMatchObject({ key: 'insights', ok: true });
    expect(checks[3].detail).toContain('1 anúncio');
  });

  it('acesso OK mas sem veiculação não é reportado como erro', async () => {
    mockTokenOk()
      .mockResolvedValueOnce(okJson({ id: 'px1', name: 'DS' }))
      .mockResolvedValueOnce(okJson({ id: 'act_1', name: 'Conta', currency: 'BRL' }))
      .mockResolvedValueOnce(okJson({ data: [] }));

    const checks = await metaCapiService.checkConnection('tok', 'px1', 'act_1', {
      since: '2026-08-01',
      until: '2026-08-10',
    });

    expect(checks[3].ok).toBe(true);
    expect(checks[3].detail).toContain('nenhum anúncio');
  });
});
