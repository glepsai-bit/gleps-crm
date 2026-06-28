/**
 * AREA T3 — Seguranca / SSRF guard.
 *
 * Cobertura dos casos descritos no brief, incluindo o bypass IPv4-mapped
 * COMPRESSED (::ffff:7f00:1) que motivou o fix do CRITIC.
 *
 * isSafeOutboundUrl devolve { ok, reason } — sempre verificamos `ok`.
 */

import { describe, it, expect } from 'vitest';
import { isSafeOutboundUrl } from './ssrf-guard';

describe('ssrf-guard / isSafeOutboundUrl', () => {
  it('bloqueia loopback IPv4 (127.0.0.1)', () => {
    const result = isSafeOutboundUrl('http://127.0.0.1/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia hostname localhost', () => {
    const result = isSafeOutboundUrl('http://localhost/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia AWS/GCP metadata (169.254.169.254)', () => {
    const result = isSafeOutboundUrl('http://169.254.169.254/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia RFC1918 10/8 (10.0.0.1)', () => {
    const result = isSafeOutboundUrl('http://10.0.0.1/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia RFC1918 172.16/12 (172.16.0.1)', () => {
    const result = isSafeOutboundUrl('http://172.16.0.1/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia RFC1918 192.168/16 (192.168.1.1)', () => {
    const result = isSafeOutboundUrl('http://192.168.1.1/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia loopback IPv6 (::1)', () => {
    const result = isSafeOutboundUrl('http://[::1]/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia IPv4-mapped IPv6 forma DOTTED (::ffff:127.0.0.1)', () => {
    const result = isSafeOutboundUrl('http://[::ffff:127.0.0.1]/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia IPv4-mapped IPv6 forma COMPRIMIDA (::ffff:7f00:1) — bypass CRITIC', () => {
    // new URL() normaliza ::ffff:127.0.0.1 para a forma comprimida ::ffff:7f00:1.
    // Se a regex SSRF cobrir somente a forma dotted, o atacante usa essa forma
    // para evadir o filtro e bater no loopback (127.0.0.1) via fetch.
    const result = isSafeOutboundUrl('http://[::ffff:7f00:1]/');
    expect(result.ok).toBe(false);
  });

  it('bloqueia protocolo file://', () => {
    const result = isSafeOutboundUrl('file:///etc/passwd');
    expect(result.ok).toBe(false);
  });

  it('bloqueia protocolo javascript:', () => {
    const result = isSafeOutboundUrl('javascript:alert(1)');
    expect(result.ok).toBe(false);
  });

  it('bloqueia URL com credenciais embutidas (user:pass@host)', () => {
    const result = isSafeOutboundUrl('http://user:pass@evil.com/');
    expect(result.ok).toBe(false);
  });

  it('permite URL publica HTTPS valida', () => {
    const result = isSafeOutboundUrl('https://exemplo.com/webhook');
    expect(result.ok).toBe(true);
  });

  it('bloqueia 0.0.0.0 (unspecified)', () => {
    const result = isSafeOutboundUrl('http://0.0.0.0/');
    expect(result.ok).toBe(false);
  });
});
