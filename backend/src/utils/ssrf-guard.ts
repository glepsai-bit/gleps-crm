/**
 * SSRF guard for outbound webhook URLs.
 *
 * Bloqueia destinos que permitem a um tenant atacante exfiltrar informacao
 * interna ou pivotar para servicos privados:
 *  - schemes nao-HTTP(S) (file://, javascript:, gopher:, etc.)
 *  - loopback (127.0.0.0/8, ::1, localhost)
 *  - RFC1918 (10/8, 172.16/12, 192.168/16)
 *  - link-local + AWS/GCP metadata (169.254/16, 169.254.169.254)
 *  - Docker / k8s internal DNS (*.internal, *.local, *.cluster.local)
 *
 * Usado em duas camadas (defesa em profundidade):
 *  1) Schema zod ao criar/editar WebhookSubscription.
 *  2) Antes de cada `fetch` no service — protege contra (a) URLs que
 *     escaparam validacao por mudanca de schema/dados legados e (b) redirects
 *     para destinos privados.
 */

import { isIP } from 'net';

const BLOCKED_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.cluster.local'];

export interface SsrfCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verifica se um hostname/IP literal aponta para destino privado/restrito.
 * Aceita IPv4, IPv6 e nomes DNS. Para nomes DNS, faz apenas checagem
 * textual (loopback/suffixes); a checagem de IP resolvido eh feita no fetch
 * via `assertSafeFetchTarget` (que tambem cobre redirects).
 */
export function isPrivateHostname(hostnameRaw: string): SsrfCheckResult {
  if (!hostnameRaw) {
    return { ok: false, reason: 'hostname vazio' };
  }

  // URL.hostname para IPv6 vem com colchetes — `new URL` ja remove, mas
  // garantimos aqui caso seja chamado diretamente.
  const hostname = hostnameRaw.replace(/^\[|\]$/g, '').toLowerCase();

  if (hostname === 'localhost') {
    return { ok: false, reason: 'loopback (localhost)' };
  }

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
      return { ok: false, reason: `dominio interno (${suffix})` };
    }
  }

  const ipVersion = isIP(hostname);

  if (ipVersion === 4) {
    return checkIPv4(hostname);
  }

  if (ipVersion === 6) {
    return checkIPv6(hostname);
  }

  return { ok: true };
}

function checkIPv4(ip: string): SsrfCheckResult {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p))) {
    return { ok: false, reason: 'IPv4 invalido' };
  }
  const [a, b] = parts as [number, number, number, number];

  // 0.0.0.0/8 — "this network"
  if (a === 0) return { ok: false, reason: '0.0.0.0/8' };
  // 127.0.0.0/8 — loopback
  if (a === 127) return { ok: false, reason: 'loopback (127/8)' };
  // 10.0.0.0/8
  if (a === 10) return { ok: false, reason: 'privada (10/8)' };
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return { ok: false, reason: 'privada (172.16/12)' };
  // 192.168.0.0/16
  if (a === 192 && b === 168) return { ok: false, reason: 'privada (192.168/16)' };
  // 169.254.0.0/16 — link-local + AWS/GCP metadata (169.254.169.254)
  if (a === 169 && b === 254) return { ok: false, reason: 'link-local/metadata (169.254/16)' };
  // 100.64.0.0/10 — CGNAT
  if (a === 100 && b >= 64 && b <= 127) return { ok: false, reason: 'CGNAT (100.64/10)' };
  // 224.0.0.0/4 — multicast
  if (a >= 224 && a <= 239) return { ok: false, reason: 'multicast (224/4)' };
  // 240.0.0.0/4 — reserved
  if (a >= 240) return { ok: false, reason: 'reservada (240/4)' };

  return { ok: true };
}

function checkIPv6(ip: string): SsrfCheckResult {
  const normalized = ip.toLowerCase();

  // ::1 loopback
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return { ok: false, reason: 'loopback IPv6 (::1)' };
  }
  // :: unspecified
  if (normalized === '::') {
    return { ok: false, reason: 'unspecified IPv6 (::)' };
  }
  // fe80::/10 link-local
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') ||
      normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return { ok: false, reason: 'link-local IPv6 (fe80::/10)' };
  }
  // fc00::/7 unique local (fc.. / fd..)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) {
    return { ok: false, reason: 'unique-local IPv6 (fc00::/7)' };
  }
  // ff00::/8 multicast
  if (normalized.startsWith('ff')) {
    return { ok: false, reason: 'multicast IPv6 (ff00::/8)' };
  }
  // IPv4-mapped IPv6 pode vir em DUAS formas:
  //  (a) dotted:    ::ffff:127.0.0.1
  //  (b) compressed: ::ffff:7f00:1 (new URL() normaliza pra essa)
  // Bypass anterior: regex so cobria (a), atacante usava forma (b) pra evadir.
  const mappedDotted = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mappedDotted && mappedDotted[1]) {
    return checkIPv4(mappedDotted[1]);
  }
  const mappedHex = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex && mappedHex[1] && mappedHex[2]) {
    const h1 = parseInt(mappedHex[1], 16);
    const h2 = parseInt(mappedHex[2], 16);
    const v4 = `${(h1 >> 8) & 0xff}.${h1 & 0xff}.${(h2 >> 8) & 0xff}.${h2 & 0xff}`;
    return checkIPv4(v4);
  }
  // Qualquer outra forma com prefixo ::ffff: que nao foi possivel parsear:
  // bloquear por seguranca (IPv4-mapped sempre tem 32 bits finais — se nao casou,
  // eh malformado e nao deveria estar como destino de webhook).
  if (normalized.startsWith('::ffff:')) {
    return { ok: false, reason: 'IPv4-mapped IPv6 malformado (::ffff:*)' };
  }

  return { ok: true };
}

/**
 * Valida uma URL completa (string). Reaproveitado pelo schema zod e pelo
 * runtime check antes de cada fetch.
 */
export function isSafeOutboundUrl(urlString: string): SsrfCheckResult {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return { ok: false, reason: 'URL invalida' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: `protocolo nao permitido (${parsed.protocol})` };
  }

  // Credenciais embutidas (http://user:pass@host) abrem espaco para abuso
  // (ex.: log injection, smuggling) — rejeitamos.
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credenciais embutidas na URL nao sao permitidas' };
  }

  return isPrivateHostname(parsed.hostname);
}

/**
 * Defesa em profundidade no momento do fetch: roda a mesma checagem
 * textual + tenta resolver o hostname para garantir que nao aponta para IP
 * privado (proteje contra DNS rebinding e dados legados).
 *
 * Lanca Error se o destino for proibido. Resolve-se com void caso seguro.
 */
export async function assertSafeFetchTarget(urlString: string): Promise<void> {
  const textual = isSafeOutboundUrl(urlString);
  if (!textual.ok) {
    throw new Error(`SSRF guard: ${textual.reason}`);
  }

  const parsed = new URL(urlString);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // Se ja eh IP literal, isSafeOutboundUrl ja validou — evitamos DNS lookup.
  if (isIP(host)) {
    return;
  }

  // Lazy import para evitar custo em hot paths que so usam validacao textual.
  const { promises: dns } = await import('dns');
  let addresses: { address: string; family: number }[] = [];
  try {
    addresses = await dns.lookup(host, { all: true });
  } catch {
    // Falha de DNS sera tratada pelo fetch normalmente — nao bloqueamos aqui
    // para nao mascarar erros legitimos com mensagem de SSRF.
    return;
  }

  for (const { address } of addresses) {
    const check = isPrivateHostname(address);
    if (!check.ok) {
      throw new Error(
        `SSRF guard: hostname "${host}" resolve para IP proibido (${address}): ${check.reason}`
      );
    }
  }
}

/**
 * Wrapper sobre `fetch` que:
 *  - valida URL inicial via `assertSafeFetchTarget`
 *  - desabilita follow de redirect automatico (redirect: 'manual')
 *  - segue manualmente ate `maxRedirects`, revalidando cada destino
 *
 * Isso bloqueia o classico "open redirect -> 169.254.169.254" e impede
 * que um servidor honesto redirecione um POST do nosso webhook para um
 * destino privado.
 */
export interface SafeFetchOptions extends RequestInit {
  maxRedirects?: number;
}

export async function safeFetch(
  urlString: string,
  options: SafeFetchOptions = {}
): Promise<Response> {
  const { maxRedirects = 3, ...rest } = options;
  let currentUrl = urlString;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeFetchTarget(currentUrl);

    const response = await fetch(currentUrl, {
      ...rest,
      redirect: 'manual',
    });

    // Status 3xx com Location => seguimos manualmente revalidando.
    const isRedirect =
      response.status >= 300 && response.status < 400 && response.headers.has('location');

    if (!isRedirect) {
      return response;
    }

    if (hop === maxRedirects) {
      throw new Error(`SSRF guard: excedido limite de ${maxRedirects} redirects`);
    }

    const location = response.headers.get('location');
    if (!location) {
      return response;
    }

    // Resolve relativo ao currentUrl (mesmo padrao do fetch).
    currentUrl = new URL(location, currentUrl).toString();
  }

  // Inalcancavel pelo loop acima, mas mantemos para o TS.
  throw new Error('SSRF guard: fluxo de redirect inesperado');
}
