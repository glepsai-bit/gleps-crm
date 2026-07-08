import { describe, it, expect } from 'vitest';
import {
  isOggOpus,
  transcodeToOggOpus,
  decodeDataUrlBase64,
} from '../audio-transcode.util';

describe('decodeDataUrlBase64 — regressao critica', () => {
  // Antes desse fix, o codigo usava regex `/^data:[^;]+;base64,/` que so
  // funcionava quando o media type NAO tinha parametros. Chrome/Edge/Firefox
  // sempre incluem `;codecs=opus` -> regex falhava -> Buffer.from decodificava
  // o header inteiro como base64 e o dispatch mandava lixo. Estes testes
  // travam o comportamento correto e impedem que a regressao volte.

  it('data:audio/webm;codecs=opus (Chrome/Edge) decodifica os bytes reais', () => {
    // AQIDBA== base64 = [0x01, 0x02, 0x03, 0x04]
    const dataUrl = 'data:audio/webm;codecs=opus;base64,AQIDBA==';
    const buf = decodeDataUrlBase64(dataUrl);
    expect(buf.length).toBe(4);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it('data:audio/ogg;codecs=opus (Firefox) decodifica os bytes reais', () => {
    const dataUrl = 'data:audio/ogg;codecs=opus;base64,AQIDBA==';
    const buf = decodeDataUrlBase64(dataUrl);
    expect(Array.from(buf)).toEqual([1, 2, 3, 4]);
  });

  it('data URL sem parametros continua funcionando', () => {
    const dataUrl = 'data:audio/ogg;base64,AQIDBA==';
    expect(Array.from(decodeDataUrlBase64(dataUrl))).toEqual([1, 2, 3, 4]);
  });

  it('OggS magic bytes (4f 67 67 53) recuperados corretamente do data URL', () => {
    // Simula um arquivo OGG valido de 4 bytes — o inicio de qualquer container OGG.
    // "OggS" em base64 = "T2dnUw=="
    const dataUrl = 'data:audio/ogg;codecs=opus;base64,T2dnUw==';
    const buf = decodeDataUrlBase64(dataUrl);
    expect(buf.toString('ascii')).toBe('OggS');
  });

  it('lanca em data URL sem virgula', () => {
    expect(() => decodeDataUrlBase64('data:audio/webm;base64')).toThrow(/virgula/);
  });
});

describe('isOggOpus', () => {
  it('true para audio/ogg', () => {
    expect(isOggOpus('audio/ogg')).toBe(true);
  });

  it('true para audio/ogg;codecs=opus (Firefox)', () => {
    expect(isOggOpus('audio/ogg;codecs=opus')).toBe(true);
  });

  it('true case-insensitive', () => {
    expect(isOggOpus('AUDIO/OGG')).toBe(true);
  });

  it('true para audio/opus (raro mas valido)', () => {
    expect(isOggOpus('audio/opus')).toBe(true);
  });

  it('false para audio/webm (Chrome/Edge — precisa transcodar)', () => {
    expect(isOggOpus('audio/webm')).toBe(false);
    expect(isOggOpus('audio/webm;codecs=opus')).toBe(false);
  });

  it('false para audio/mp4 (Safari)', () => {
    expect(isOggOpus('audio/mp4')).toBe(false);
  });

  it('false para null/undefined/vazio', () => {
    expect(isOggOpus(null)).toBe(false);
    expect(isOggOpus(undefined)).toBe(false);
    expect(isOggOpus('')).toBe(false);
  });
});

describe('transcodeToOggOpus — passthrough sem chamar ffmpeg', () => {
  it('devolve buffer inalterado quando source ja e OGG', async () => {
    const buf = Buffer.from([0x4f, 0x67, 0x67, 0x53]); // "OggS" magic bytes
    const out = await transcodeToOggOpus(buf, 'audio/ogg;codecs=opus');
    expect(out.transcoded).toBe(false);
    expect(out.mimeType).toBe('audio/ogg');
    expect(out.buffer).toBe(buf);
  });

  it('degrada gracefully quando input e invalido (ffmpeg falha) — devolve original', async () => {
    // 8 bytes aleatorios que nao formam nenhum container — ffmpeg vai rejeitar
    // no probe. Nao queremos que a rejeicao levante; queremos passthrough
    // com transcoded=false para o dispatch tentar assim mesmo.
    const buf = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = await transcodeToOggOpus(buf, 'audio/webm');
    expect(out.transcoded).toBe(false);
    expect(out.buffer).toBe(buf);
  });
});
