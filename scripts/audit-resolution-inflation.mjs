#!/usr/bin/env node
/**
 * audit-resolution-inflation.mjs
 * ------------------------------
 * Diagnostico pontual (NAO automatico) para detectar inflacao na tabela
 * `resolution_logs` quando comparada com a verdade do Chatwoot.
 *
 * O QUE FAZ:
 *   1. Conta linhas em resolution_logs no periodo informado.
 *   2. Pagina /api/v1/accounts/{id}/conversations?status=resolved do Chatwoot
 *      e conta as resolvidas no mesmo periodo (por last_activity_at).
 *   3. Compara: delta absoluto e percentual. Sinaliza se > 10%.
 *   4. Detecta duplicatas suspeitas em resolution_logs: mesma
 *      (account_id, conversation_id) com varias linhas dentro de 1 minuto.
 *
 * NAO ESCREVE NADA. NAO ALTERA NADA.
 *
 * Uso:
 *   DATABASE_URL=postgresql://gleps:gleps_secret@localhost:5432/gleps_crm \
 *     node scripts/audit-resolution-inflation.mjs \
 *     --account=<uuid-da-conta-no-CRM> \
 *     --from=2026-06-01 --to=2026-06-15
 *
 * Requisitos:
 *   - psql disponivel no PATH
 *   - Node 20+ (usa fetch nativo)
 *   - DATABASE_URL apontando para o Postgres com o schema do GLEPS CRM
 */
import { execSync } from 'node:child_process';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

const ACCOUNT_ID = args.account || args['account-id'];
const FROM = args.from;
const TO = args.to;
const DATABASE_URL = process.env.DATABASE_URL;

if (!ACCOUNT_ID || !FROM || !TO) {
  console.error('Uso: node scripts/audit-resolution-inflation.mjs --account=<uuid> --from=YYYY-MM-DD --to=YYYY-MM-DD');
  console.error('Requer env DATABASE_URL definida.');
  process.exit(2);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao definida no ambiente.');
  process.exit(2);
}

const FROM_DATE = `${FROM} 00:00:00`;
const TO_DATE = `${TO} 23:59:59`;

function psql(sql) {
  const cmd = ['psql', DATABASE_URL, '-tAc', sql];
  return execSync(cmd.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' '), {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fail(msg, err) {
  console.error(`[audit] ${msg}`);
  if (err) console.error('  detalhe:', err.message?.split('\n')[0]);
  process.exit(1);
}

// 1. Carrega config Chatwoot da conta
let cwUrl, cwAccountId, cwApiKey, cwAccountNome;
try {
  const row = psql(
    `SELECT chatwoot_base_url || '|' || chatwoot_account_id || '|' || chatwoot_api_key || '|' || nome FROM accounts WHERE id = '${ACCOUNT_ID}'::uuid`
  );
  if (!row) fail(`account ${ACCOUNT_ID} nao encontrada`);
  [cwUrl, cwAccountId, cwApiKey, cwAccountNome] = row.split('|');
  if (!cwUrl || !cwAccountId || !cwApiKey) {
    fail(`account ${ACCOUNT_ID} ("${cwAccountNome}") nao tem credenciais Chatwoot configuradas`);
  }
} catch (e) {
  fail('falha ao consultar accounts via psql', e);
}

console.log(`\nAuditoria — conta "${cwAccountNome}" (${ACCOUNT_ID})`);
console.log(`Janela: ${FROM} ate ${TO}\n`);

// 2. Conta resolution_logs do periodo
let dbCount = 0;
let dbAiCount = 0;
let dbHumanCount = 0;
try {
  dbCount = Number(
    psql(
      `SELECT COUNT(*) FROM resolution_logs WHERE account_id = '${ACCOUNT_ID}'::uuid AND resolved_at >= '${FROM_DATE}'::timestamptz AND resolved_at <= '${TO_DATE}'::timestamptz`
    ) || '0'
  );
  dbAiCount = Number(
    psql(
      `SELECT COUNT(*) FROM resolution_logs WHERE account_id = '${ACCOUNT_ID}'::uuid AND resolved_at >= '${FROM_DATE}'::timestamptz AND resolved_at <= '${TO_DATE}'::timestamptz AND resolved_by = 'ai'`
    ) || '0'
  );
  dbHumanCount = Number(
    psql(
      `SELECT COUNT(*) FROM resolution_logs WHERE account_id = '${ACCOUNT_ID}'::uuid AND resolved_at >= '${FROM_DATE}'::timestamptz AND resolved_at <= '${TO_DATE}'::timestamptz AND resolved_by = 'human'`
    ) || '0'
  );
} catch (e) {
  fail('falha ao contar resolution_logs', e);
}

console.log(`resolution_logs: ${dbCount} total (ai=${dbAiCount}, human=${dbHumanCount})`);

// 3. Conta conversas Chatwoot resolvidas no periodo
const fromMs = new Date(FROM_DATE).getTime();
const toMs = new Date(TO_DATE).getTime();
let cwResolvedCount = 0;
let cwTotalScanned = 0;
let page = 1;
const MAX_PAGES = 60; // safety: 60 paginas * 25 (default Chatwoot) = 1500 conversas

while (page <= MAX_PAGES) {
  const url = `${cwUrl.replace(/\/+$/, '')}/api/v1/accounts/${cwAccountId}/conversations?status=resolved&page=${page}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { api_access_token: cwApiKey },
    });
  } catch (e) {
    fail(`erro de rede ao buscar pagina ${page} do Chatwoot`, e);
  }
  if (!resp.ok) {
    fail(`Chatwoot retornou HTTP ${resp.status} na pagina ${page}`);
  }
  const json = await resp.json();
  const payload = json?.data?.payload || [];
  cwTotalScanned += payload.length;
  for (const conv of payload) {
    const lastActivity = typeof conv.last_activity_at === 'number'
      ? conv.last_activity_at * 1000
      : new Date(conv.last_activity_at).getTime();
    if (lastActivity >= fromMs && lastActivity <= toMs) {
      cwResolvedCount++;
    }
  }
  if (payload.length < 25) break; // ultima pagina
  page++;
}

console.log(`chatwoot resolved: ${cwResolvedCount} no periodo (de ${cwTotalScanned} totais escaneados em ${page} pagina(s))`);

const delta = dbCount - cwResolvedCount;
const deltaPct = cwResolvedCount > 0 ? Math.round((delta / cwResolvedCount) * 100) : (dbCount > 0 ? 999 : 0);
console.log(`delta: ${delta > 0 ? '+' : ''}${delta} (${deltaPct > 0 ? '+' : ''}${deltaPct}%)`);

if (Math.abs(deltaPct) > 10) {
  console.log('⚠️  Delta > 10%. Possivel inflação ou subcontagem. Investigar.');
} else {
  console.log('✓  Delta dentro da tolerancia (≤ 10%).');
}

// 4. Duplicatas suspeitas (mesma conversation com varias linhas em < 1min)
console.log('\n— duplicatas suspeitas (mesma conversa logada mais de 1x dentro de 1 minuto) —');
try {
  const dupRows = psql(`
    SELECT conversation_id || '|' || COUNT(*) || '|' || MIN(resolved_at)::text || '|' || MAX(resolved_at)::text
    FROM resolution_logs
    WHERE account_id = '${ACCOUNT_ID}'::uuid
      AND resolved_at >= '${FROM_DATE}'::timestamptz
      AND resolved_at <= '${TO_DATE}'::timestamptz
    GROUP BY conversation_id
    HAVING COUNT(*) > 1
       AND EXTRACT(EPOCH FROM (MAX(resolved_at) - MIN(resolved_at))) < 60
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `);
  if (!dupRows) {
    console.log('(nenhuma)');
  } else {
    const lines = dupRows.split('\n');
    console.log(`encontrei ${lines.length} grupo(s) suspeito(s) (mostrando ate 20):`);
    for (const l of lines) {
      const [convId, count, first, last] = l.split('|');
      console.log(`  conversation_id=${convId}  count=${count}  ${first} -> ${last}`);
    }
  }
} catch (e) {
  fail('falha ao consultar duplicatas', e);
}

console.log('\nFim.');
