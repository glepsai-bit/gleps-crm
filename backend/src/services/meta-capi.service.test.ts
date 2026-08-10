import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { hashPhone, metaCapiService } from './meta-capi.service';

describe('hashPhone', () => {
  it('normaliza (só dígitos) — mesmo número em formatos diferentes -> mesmo hash', () => {
    const a = hashPhone('+55 34 99338-3017');
    const b = hashPhone('5534993383017');
    expect(a).toBe(b);
    expect(a).toBe(createHash('sha256').update('5534993383017').digest('hex'));
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('sem dígitos / vazio / null -> null', () => {
    expect(hashPhone('')).toBeNull();
    expect(hashPhone(null)).toBeNull();
    expect(hashPhone(undefined)).toBeNull();
    expect(hashPhone('abc')).toBeNull();
  });
});

describe('metaCapiService.sendEvent — payload CAPI', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events_received: 1 }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const bodyOf = () => JSON.parse((fetchMock.mock.calls[0][1] as any).body);

  it('inclui event_id, user_data.ph (hasheado) e ctwa_clid', async () => {
    await metaCapiService.sendEvent(
      { accessToken: 'tok', pixelId: 'px123' },
      {
        eventName: 'Lead',
        ctwaClid: 'CLID_ABC',
        eventTime: 1_700_000_000,
        eventId: 'evt-uuid-1',
        phone: '+55 34 99338-3017',
      }
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, unknown];
    expect(url).toContain('/px123/events');

    const ev = bodyOf().data[0];
    expect(ev.event_id).toBe('evt-uuid-1');
    expect(ev.action_source).toBe('business_messaging');
    expect(ev.messaging_channel).toBe('whatsapp');
    expect(ev.user_data.ctwa_clid).toBe('CLID_ABC');
    expect(ev.user_data.ph).toEqual([hashPhone('5534993383017')]);
    expect(bodyOf().access_token).toBe('tok');
  });

  it('sem telefone -> não inclui ph; sem eventId -> não inclui event_id', async () => {
    await metaCapiService.sendEvent(
      { accessToken: 'tok', pixelId: 'px123' },
      { eventName: 'Lead', ctwaClid: 'CLID', eventTime: 1_700_000_000 }
    );
    const ev = bodyOf().data[0];
    expect(ev.user_data.ph).toBeUndefined();
    expect(ev.event_id).toBeUndefined();
    expect(ev.user_data.ctwa_clid).toBe('CLID');
  });

  it('Purchase inclui custom_data.value/currency + ph', async () => {
    await metaCapiService.sendEvent(
      { accessToken: 'tok', pixelId: 'px' },
      {
        eventName: 'Purchase',
        ctwaClid: 'C',
        eventTime: 1,
        value: 250,
        currency: 'BRL',
        eventId: 'e',
        phone: '5511999998888',
      }
    );
    const ev = bodyOf().data[0];
    expect(ev.custom_data).toEqual({ value: 250, currency: 'BRL' });
    expect(ev.user_data.ph).toEqual([hashPhone('5511999998888')]);
  });

  it('erro HTTP -> lança (caller trata como best-effort)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'bad', code: 100 } }),
    });
    await expect(
      metaCapiService.sendEvent(
        { accessToken: 't', pixelId: 'p' },
        { eventName: 'Lead', ctwaClid: 'C', eventTime: 1 }
      )
    ).rejects.toThrow(/Meta CAPI 400/);
  });
});
