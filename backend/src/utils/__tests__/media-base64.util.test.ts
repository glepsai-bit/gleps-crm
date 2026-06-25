/**
 * Tests for media-base64.util
 * ============================
 *
 * Cobertura:
 *  - decodeDataUrl: aceita formato válido, rejeita inválidos, decodifica payload
 *  - toDataUrl: roundtrip com decodeDataUrl
 *  - saveTempMedia + getTempFile: grava em disco, recupera, expira por TTL
 *  - deleteTempFile + cleanupExpired: cleanup explícito e por TTL
 *  - fetchFromUrl: rejeita protocolos não-HTTP, baixa via fetch mockado
 *  - buildPublicUrl (via __internal): respeita PUBLIC_API_URL e fallback relativo
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decodeDataUrl,
  toDataUrl,
  saveTempMedia,
  getTempFile,
  deleteTempFile,
  cleanupExpired,
  fetchFromUrl,
  __internal,
} from '../media-base64.util';

const FIXTURE_DIR = path.join(os.tmpdir(), `gleps-media-test-${process.pid}`);

beforeAll(async () => {
  process.env.TEMP_MEDIA_DIR = FIXTURE_DIR;
  await fs.mkdir(FIXTURE_DIR, { recursive: true });
});

beforeEach(() => {
  __internal.tempRegistry.clear();
});

afterEach(async () => {
  // Sanitiza qualquer arquivo deixado por testes.
  try {
    const files = await fs.readdir(FIXTURE_DIR);
    await Promise.all(files.map((f) => fs.unlink(path.join(FIXTURE_DIR, f)).catch(() => undefined)));
  } catch {
    // ignore
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ============================================
// decodeDataUrl
// ============================================

describe('decodeDataUrl', () => {
  it('decodifica data URL válida com mime', () => {
    // "hello" em base64 = "aGVsbG8="
    const result = decodeDataUrl('data:text/plain;base64,aGVsbG8=');
    expect(result.mimeType).toBe('text/plain');
    expect(result.buffer.toString('utf-8')).toBe('hello');
  });

  it('aceita data URL sem mime (default application/octet-stream)', () => {
    const result = decodeDataUrl('data:;base64,aGVsbG8=');
    expect(result.mimeType).toBe('application/octet-stream');
    expect(result.buffer.toString('utf-8')).toBe('hello');
  });

  it('tolera parâmetros extras (ex: name=foo.pdf) entre mime e ;base64', () => {
    const result = decodeDataUrl('data:application/pdf;name=foo.pdf;base64,aGVsbG8=');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.buffer.toString('utf-8')).toBe('hello');
  });

  it('normaliza mime para lowercase', () => {
    const result = decodeDataUrl('data:IMAGE/JPEG;base64,aGVsbG8=');
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('decodifica imagem JPEG real (magic bytes FFD8)', () => {
    // 1x1 JPEG mínimo (header + EOI).
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00,
      0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    const result = decodeDataUrl(dataUrl);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.buffer.length).toBe(jpeg.length);
    expect(result.buffer[0]).toBe(0xff);
    expect(result.buffer[1]).toBe(0xd8);
  });

  it('rejeita string vazia', () => {
    expect(() => decodeDataUrl('')).toThrow(/dataUrl é obrigatório/);
  });

  it('rejeita formato não data:', () => {
    expect(() => decodeDataUrl('https://foo.com/img.jpg')).toThrow(/formato data:/);
  });

  it('rejeita data URL sem ;base64 marker', () => {
    expect(() => decodeDataUrl('data:text/plain,hello')).toThrow(/formato data:/);
  });

  it('rejeita payload base64 vazio', () => {
    expect(() => decodeDataUrl('data:text/plain;base64,')).toThrow(/formato data:|vazio/);
  });

  it('rejeita payload acima do tamanho máximo', () => {
    // Cria payload > 25MB. Buffer de ~26MB → base64 ~34MB.
    const big = Buffer.alloc(26 * 1024 * 1024, 0x41);
    const dataUrl = `data:application/octet-stream;base64,${big.toString('base64')}`;
    expect(() => decodeDataUrl(dataUrl)).toThrow(/tamanho máximo/);
  });
});

// ============================================
// toDataUrl
// ============================================

describe('toDataUrl', () => {
  it('roundtrip com decodeDataUrl preserva conteúdo e mime', () => {
    const original = Buffer.from('teste roundtrip', 'utf-8');
    const dataUrl = toDataUrl(original, 'text/plain');
    const decoded = decodeDataUrl(dataUrl);
    expect(decoded.mimeType).toBe('text/plain');
    expect(decoded.buffer.equals(original)).toBe(true);
  });

  it('default mime para application/octet-stream quando vazio', () => {
    const dataUrl = toDataUrl(Buffer.from('x'), '');
    expect(dataUrl.startsWith('data:application/octet-stream;base64,')).toBe(true);
  });
});

// ============================================
// saveTempMedia + getTempFile
// ============================================

describe('saveTempMedia + getTempFile', () => {
  it('grava arquivo em disco, devolve url e tempPath, getTempFile recupera', async () => {
    const buf = Buffer.from('contents do arquivo', 'utf-8');
    const saved = await saveTempMedia(buf, 'image/png');

    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.tempPath.endsWith('.png')).toBe(true);
    expect(saved.url).toContain(saved.id);
    expect(saved.mimeType).toBe('image/png');
    expect(saved.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Disco
    const onDisk = await fs.readFile(saved.tempPath);
    expect(onDisk.equals(buf)).toBe(true);

    // Registry
    const recovered = getTempFile(saved.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.tempPath).toBe(saved.tempPath);

    // Aceita formato `uuid.ext` também
    const recoveredWithExt = getTempFile(`${saved.id}.png`);
    expect(recoveredWithExt).not.toBeNull();
  });

  it('escolhe extensão correta a partir do mime', async () => {
    const samples: Array<[string, string]> = [
      ['image/jpeg', '.jpg'],
      ['audio/ogg', '.ogg'],
      ['application/pdf', '.pdf'],
      ['video/mp4', '.mp4'],
      ['application/x-coisa-desconhecida', '.bin'],
    ];
    for (const [mime, expectedExt] of samples) {
      const saved = await saveTempMedia(Buffer.from('x'), mime);
      expect(saved.tempPath.endsWith(expectedExt)).toBe(true);
    }
  });

  it('respeita TTL — getTempFile devolve null após expirar', async () => {
    const saved = await saveTempMedia(Buffer.from('x'), 'image/png', { ttlMs: 50 });
    expect(getTempFile(saved.id)).not.toBeNull();

    // Espera passar o TTL
    await new Promise((r) => setTimeout(r, 80));
    expect(getTempFile(saved.id)).toBeNull();
  });

  it('rejeita buffer vazio', async () => {
    await expect(saveTempMedia(Buffer.alloc(0), 'image/png')).rejects.toThrow(/vazio|inválido/);
  });

  it('rejeita buffer acima do tamanho máximo', async () => {
    const big = Buffer.alloc(__internal.MAX_MEDIA_BYTES + 1, 0x41);
    await expect(saveTempMedia(big, 'application/octet-stream')).rejects.toThrow(/tamanho máximo/);
  });
});

// ============================================
// deleteTempFile + cleanupExpired
// ============================================

describe('deleteTempFile + cleanupExpired', () => {
  it('deleteTempFile remove do disco e do registry', async () => {
    const saved = await saveTempMedia(Buffer.from('x'), 'image/png');
    await deleteTempFile(saved.id);

    expect(getTempFile(saved.id)).toBeNull();
    // FS confirma
    await expect(fs.access(saved.tempPath)).rejects.toThrow();
  });

  it('deleteTempFile é idempotente (chamar duas vezes não lança)', async () => {
    const saved = await saveTempMedia(Buffer.from('x'), 'image/png');
    await deleteTempFile(saved.id);
    await expect(deleteTempFile(saved.id)).resolves.toBeUndefined();
  });

  it('cleanupExpired remove apenas entries expiradas', async () => {
    // Usa TTL longo pra evitar race com o timer interno do save, e força
    // expiração manualmente no registry — isolando o teste do scheduling.
    const expired = await saveTempMedia(Buffer.from('a'), 'image/png', { ttlMs: 60_000 });
    const fresh = await saveTempMedia(Buffer.from('b'), 'image/png', { ttlMs: 60_000 });

    // Mutaciona expiresAt da primeira entry pra simular expiração no passado.
    const entry = __internal.tempRegistry.get(expired.id);
    expect(entry).toBeDefined();
    entry!.expiresAt = Date.now() - 1000;

    const removed = await cleanupExpired();
    expect(removed).toBeGreaterThanOrEqual(1);

    expect(getTempFile(expired.id)).toBeNull();
    expect(getTempFile(fresh.id)).not.toBeNull();
  });
});

// ============================================
// fetchFromUrl
// ============================================

describe('fetchFromUrl', () => {
  it('rejeita URLs que não são http(s)', async () => {
    await expect(fetchFromUrl('ftp://foo/bar.jpg')).rejects.toThrow(/http\(s\)/);
    await expect(fetchFromUrl('data:image/png;base64,xxx')).rejects.toThrow(/http\(s\)/);
  });

  it('baixa conteúdo e devolve buffer + mimeType (sem charset)', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-type': 'image/png; charset=binary',
        'content-length': String(payload.length),
      }),
      arrayBuffer: async () => payload.buffer,
    });
    vi.stubGlobal('fetch', fakeFetch);

    const result = await fetchFromUrl('https://example.com/x.png');
    expect(result.mimeType).toBe('image/png');
    expect(result.buffer.length).toBe(5);
    expect(Array.from(result.buffer)).toEqual([1, 2, 3, 4, 5]);
    expect(fakeFetch).toHaveBeenCalledOnce();
  });

  it('lança quando response.ok = false', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    );
    await expect(fetchFromUrl('https://example.com/missing')).rejects.toThrow(/status 404/);
  });

  it('rejeita quando content-length excede o limite', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({
          'content-type': 'application/octet-stream',
          'content-length': String(__internal.MAX_MEDIA_BYTES + 1),
        }),
        arrayBuffer: async () => new ArrayBuffer(0),
      })
    );
    await expect(fetchFromUrl('https://example.com/big')).rejects.toThrow(/tamanho máximo/);
  });
});

// ============================================
// buildPublicUrl (interno)
// ============================================

describe('buildPublicUrl', () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('prefixa com PUBLIC_API_URL quando setado', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com/';
    const url = __internal.buildPublicUrl('abc-123', 'jpg');
    expect(url).toBe('https://api.example.com/api/temp-media/abc-123.jpg');
  });

  it('cai pra caminho relativo quando nenhum env está setado', () => {
    delete process.env.PUBLIC_API_URL;
    delete process.env.BACKEND_PUBLIC_URL;
    delete process.env.API_BASE_URL;
    const url = __internal.buildPublicUrl('abc-123', 'png');
    expect(url).toBe('/api/temp-media/abc-123.png');
  });
});
