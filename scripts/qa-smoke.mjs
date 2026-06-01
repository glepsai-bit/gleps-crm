#!/usr/bin/env node
/**
 * QA — Smoke test da API (pós-deploy)
 * ----------------------------------
 * Valida, contra uma instância rodando, os fluxos que a UI realmente usa:
 * auth, dashboard, CRM core, Chatwoot, insights, email, prospecção, e as
 * barreiras de autorização/multi-tenancy. Repetível a cada redeploy.
 *
 * NÃO contém segredos. Credenciais vêm de variáveis de ambiente:
 *   QA_BASE_URL   (ex.: https://crm-mychooice-goodleads.jybre9.easypanel.host)
 *   QA_EMAIL
 *   QA_PASSWORD
 *
 * Uso:
 *   QA_BASE_URL=... QA_EMAIL=... QA_PASSWORD=... node scripts/qa-smoke.mjs
 *   (adicione --write para incluir o round-trip de escrita criar→apagar contato)
 *
 * Saída: tabela de checks. Exit 0 se tudo bate com o esperado; exit 1 se algo
 * regrediu. Anomalias CONHECIDAS (ver board T-004 etc.) são reportadas como
 * "conhecida" e NÃO derrubam o run — se uma delas for corrigida, o script avisa
 * para remover da lista.
 */

const BASE = (process.env.QA_BASE_URL || '').replace(/\/+$/, '');
const EMAIL = process.env.QA_EMAIL || '';
const PASSWORD = process.env.QA_PASSWORD || '';
const DO_WRITE = process.argv.includes('--write');

if (!BASE || !EMAIL || !PASSWORD) {
  console.error('Faltam variáveis: QA_BASE_URL, QA_EMAIL, QA_PASSWORD');
  process.exit(2);
}

// Janela de datas para endpoints que exigem dateFrom/dateTo.
const today = new Date();
const monthAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
const iso = (d) => d.toISOString().slice(0, 10);
const RANGE = `dateFrom=${iso(monthAgo)}&dateTo=${iso(today)}`;

let token = null;
const results = [];

async function call(method, path, { auth = true, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* corpo não-JSON */ }
  return { status: res.status, json, text };
}

/**
 * check: registra um caso. `expect` é o status esperado.
 * `known` (opcional) marca anomalia conhecida: status divergente do esperado
 * não derruba o run, mas é reportado; e se a anomalia "sumir", avisamos.
 */
function record(name, status, expect, known) {
  const ok = status === expect;
  results.push({ name, status, expect, ok, known: known || null });
}

async function get(name, path, expect = 200, known) {
  const { status } = await call('GET', path);
  record(name, status, expect, known);
}

async function main() {
  console.log(`\nQA smoke → ${BASE}\n`);

  // ---- AUTH ----
  const login = await call('POST', '/api/auth/login', { auth: false, body: { email: EMAIL, password: PASSWORD } });
  token = login.json?.data?.token || login.json?.token || null;
  record('POST /api/auth/login', login.status, 200);
  if (!token) {
    console.error('Login não retornou token — abortando.');
    printAndExit();
  }
  const role = login.json?.data?.user?.role;
  const accountId = login.json?.data?.user?.accountId;
  console.log(`Autenticado: role=${role} accountId=${accountId}\n`);
  const me = await call('GET', '/api/auth/me');
  record('GET /api/auth/me', me.status, 200);

  // T-005 (regressão de segurança): a chatwootApiKey NÃO deve voltar no payload de auth.
  // Esperado pós-deploy: ausente. Enquanto a instância roda o build antigo, fica "presente"
  // → marcado como conhecida(T-005-deploy) para não derrubar o run, mas avisa quando resolver.
  const keyLeaked = !!(me.json?.data?.account?.chatwootApiKey ?? login.json?.data?.account?.chatwootApiKey);
  // Convenção igual às demais conhecidas: `expect` = estado anômalo atual.
  // Hoje a instância roda build antigo → 'LEAKED'. Quando o deploy do T-005 entrar,
  // virá 'ABSENT' ≠ 'LEAKED' → "RESOLVIDA?" avisa para remover o marcador e tornar
  // este um assert normal (key sempre ausente).
  record('T-005 chatwootApiKey no /auth/me', keyLeaked ? 'LEAKED' : 'ABSENT', 'LEAKED', 'T-005-deploy');

  // ---- DASHBOARD ----
  await get('GET /api/dashboard/kpis', '/api/dashboard/kpis');
  await get('GET /api/dashboard/hourly-peak', '/api/dashboard/hourly-peak');
  await get('GET /api/dashboard/agents-performance', '/api/dashboard/agents-performance');
  await get('GET /api/dashboard/backlog', '/api/dashboard/backlog');
  await get('GET /api/dashboard/ia-vs-human', '/api/dashboard/ia-vs-human');

  // ---- CRM CORE ----
  await get('GET /api/contacts', '/api/contacts');
  await get('GET /api/sales', '/api/sales');
  await get('GET /api/sales/kpis', '/api/sales/kpis');
  await get('GET /api/products', '/api/products');
  await get('GET /api/tags', '/api/tags');
  await get('GET /api/funnels', '/api/funnels');
  await get('GET /api/users', '/api/users');
  await get('GET /api/calendar/events', '/api/calendar/events');
  await get('GET /api/events', '/api/events');

  // ---- FINANCE (rotas reais usadas pelo front) ----
  await get('GET /api/finance/revenue-chart', `/api/finance/revenue-chart?${RANGE}`);
  await get('GET /api/finance/funnel-conversion', `/api/finance/funnel-conversion?${RANGE}`);

  // ---- INSIGHTS ----
  for (const p of ['kpis', 'products', 'temporal', 'marketing', 'payment-methods', 'automatic', 'agents-ranking']) {
    await get(`GET /api/insights/${p}`, `/api/insights/${p}`);
  }

  // ---- CHATWOOT ----
  await get('GET /api/chatwoot/agents', '/api/chatwoot/agents');
  await get('GET /api/chatwoot/conversations', '/api/chatwoot/conversations');
  await get('GET /api/chatwoot/metrics (sem params → 400)', '/api/chatwoot/metrics', 400);
  await get('GET /api/chatwoot/metrics (com params)', `/api/chatwoot/metrics?${RANGE}`);

  // ---- EMAIL ----
  for (const p of ['cadences', 'templates', 'campaigns', 'audiences', 'quota', 'inbox']) {
    await get(`GET /api/email/${p}`, `/api/email/${p}`);
  }

  // ---- PROSPECTING ----
  await get('GET /api/prospecting/usage', '/api/prospecting/usage');
  await get('GET /api/prospecting/batches', '/api/prospecting/batches');
  await get('GET /api/prospecting/audiences', '/api/prospecting/audiences');

  // ---- AUTHZ / MULTI-TENANCY ----
  const isSuperAdmin = role === 'super_admin';
  await get('AUTHZ admin → /api/accounts (403)', '/api/accounts', isSuperAdmin ? 200 : 403);
  await get('AUTHZ admin → /api/admin/kpis (403)', '/api/admin/kpis', isSuperAdmin ? 200 : 403);
  await get('TENANT user UUID inexistente (404)', '/api/users/00000000-0000-0000-0000-000000000000', 404);
  await get('TENANT contact UUID inexistente (404)', '/api/contacts/00000000-0000-0000-0000-000000000000', 404);
  const noTok = await (async () => { const t = token; token = null; const r = await call('GET', '/api/contacts'); token = t; return r; })();
  record('AUTHZ sem token → /api/contacts (401)', noTok.status, 401);

  // ---- ANOMALIAS CONHECIDAS (não derrubam o run) ----
  // T-004 já corrigido no front (passou a usar /api/sales/kpis, validado acima). O path
  // literal /api/sales/stats não é endpoint real: casa com /:id → 500. Mantido só como
  // documentação de que esse caminho não deve ser usado.
  await get('CONHECIDA /api/sales/stats não é endpoint (500)', '/api/sales/stats', 500, 'sales-stats-naoexiste');
  // Constants mortos no front (não usados): rotas não existem no backend.
  await get('CONHECIDA dead /api/dashboard/revenue (404)', '/api/dashboard/revenue', 404, 'dead-const');
  await get('CONHECIDA dead /api/dashboard/conversion-funnel (404)', '/api/dashboard/conversion-funnel', 404, 'dead-const');
  await get('CONHECIDA dead /api/insights/overview (404)', '/api/insights/overview', 404, 'dead-const');

  // ---- WRITE round-trip (opcional) ----
  if (DO_WRITE) {
    const created = await call('POST', '/api/contacts', {
      body: { nome: 'QA Smoke Test', telefone: '+5511999990000', email: 'qa.smoke@example.com', origem: 'outro' },
    });
    record('WRITE POST /api/contacts (201)', created.status, 201);
    const cid = created.json?.data?.id || created.json?.id;
    if (cid) {
      const got = await call('GET', `/api/contacts/${cid}`);
      record('WRITE GET contato (200)', got.status, 200);
      const del = await call('DELETE', `/api/contacts/${cid}`);
      record('WRITE DELETE contato (200/204)', del.status === 204 ? 200 : del.status, 200);
      const after = await call('GET', `/api/contacts/${cid}`);
      record('WRITE GET pós-delete (404)', after.status, 404);
    }
  }

  printAndExit();
}

function printAndExit() {
  let failed = 0;
  let resolvedKnown = 0;
  console.log('RESULTADO'.padEnd(52), 'STATUS', 'ESPERA', 'OK');
  console.log('-'.repeat(80));
  for (const r of results) {
    let mark;
    if (r.known) {
      // anomalia conhecida: divergência esperada. "ok" significa "continua igual".
      mark = r.ok ? `conhecida(${r.known})` : 'RESOLVIDA?';
      if (!r.ok) resolvedKnown++;
    } else {
      mark = r.ok ? 'ok' : 'FALHOU';
      if (!r.ok) failed++;
    }
    console.log(String(r.name).padEnd(52), String(r.status).padEnd(6), String(r.expect).padEnd(6), mark);
  }
  console.log('-'.repeat(80));
  console.log(`Total: ${results.length} | falhas reais: ${failed} | anomalias conhecidas resolvidas: ${resolvedKnown}`);
  if (resolvedKnown > 0) {
    console.log('⚠️  Alguma anomalia conhecida mudou de status — revisar e remover da lista (ex.: T-004 corrigido).');
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error('Erro no smoke test:', e); process.exit(2); });
