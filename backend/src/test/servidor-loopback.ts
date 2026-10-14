/**
 * Servidores HTTP de teste ligados SÓ a 127.0.0.1.
 *
 * Causa raiz do "flake" do integration-chat.controller.test.ts (14/10/2026;
 * já tinha aparecido nas etapas WD e E como "passa isolado"):
 *
 *   - o supertest faz `http.createServer(app).listen(0)` — SEM host, ou seja,
 *     no curinga `::` — e depois conecta em `http://127.0.0.1:<porta>`;
 *   - no macOS o kernel pode devolver, para esse curinga, uma porta efêmera
 *     que OUTRO processo já escuta em `127.0.0.1:<porta>` (helpers do VS Code,
 *     rapportd, extensões…). A conexão vai para o socket mais específico — o do
 *     outro processo —, que responde 404/401 por conta própria. Daí
 *     "GET sem api-key esperava 401 e veio 404" e "POST com chave válida
 *     esperava 400 e veio 401", em testes que não têm nada de errado;
 *   - medido na máquina de desenvolvimento: 21 colisões em 40.000 `listen(0)`
 *     com 11 listeners alheios (≈ 0,05% por requisição — com ~1.000 requisições
 *     numa rodada completa dá a chance de um flake por rodada); com
 *     `listen(0, '127.0.0.1')`, 0 colisões em 200.000 (o kernel recusa a porta
 *     que já tem o mesmo endereço específico).
 *
 * Correção: `listen(0)` / `listen(0, cb)` / `listen({ port: 0 })` sem host passam
 * a ligar em `127.0.0.1`. Host explícito é respeitado. Em Linux/CI o problema não
 * existe, e o patch é inofensivo lá (o supertest só conversa com 127.0.0.1).
 *
 * A ligação precisa ser SÍNCRONA: o supertest lê `server.address().port` na linha
 * seguinte ao `listen(0)`. O caminho público com host (`listen(0, '127.0.0.1')`)
 * resolve o endereço por `dns.lookup` — mesmo sendo IP literal — e só liga no
 * próximo tick; `address()` volta `null` e o supertest quebra com "Cannot read
 * properties of null (reading 'port')". Por isso o bind usa `_listen2`, o que o
 * próprio `listen` chama depois do lookup (cai no caminho com host se ele sumir).
 *
 * Importado por `setup.ts` (roda antes de cada arquivo de teste); a marca no
 * protótipo impede empilhar o patch.
 */
import http from 'node:http';

const MARCA = Symbol.for('gleps.teste.listenSoLoopback');
export const HOST_DE_TESTE = '127.0.0.1';

type Listen = (this: http.Server, ...args: unknown[]) => http.Server;
type ProtoComMarca = { listen: Listen; [MARCA]?: boolean };
type ServidorInterno = http.Server & { _handle?: unknown; _listen2?: (...args: unknown[]) => void };

/** Liga em 127.0.0.1 na hora (ver cabeçalho): `address()` já vale na linha seguinte. */
function ligarEmLoopbackSincrono(servidor: http.Server, original: Listen, resto: unknown[]): http.Server {
  const interno = servidor as ServidorInterno;
  // Já ouvindo (ERR_SERVER_ALREADY_LISTEN) ou sem o gancho interno: o caminho público, que é assíncrono.
  if (interno._handle != null || typeof interno._listen2 !== 'function') {
    return original.call(servidor, 0, HOST_DE_TESTE, ...resto);
  }
  const callback = resto.find((a): a is () => void => typeof a === 'function');
  if (callback) servidor.once('listening', callback);
  interno._listen2(HOST_DE_TESTE, 0, 4, 511, undefined, 0);
  return servidor;
}

export function prenderServidoresAoLoopback(): void {
  const proto = http.Server.prototype as unknown as ProtoComMarca;
  if (proto[MARCA]) return;

  const original = proto.listen;
  proto.listen = function listenSoLoopback(this: http.Server, ...args: unknown[]): http.Server {
    const [primeiro, segundo] = args;

    // listen(0) | listen('0') | listen(0, callback)  → sem host
    if ((primeiro === 0 || primeiro === '0') && (segundo === undefined || typeof segundo === 'function')) {
      return ligarEmLoopbackSincrono(this, original, args.slice(1));
    }

    // listen({ port: 0 }, callback) sem host
    if (primeiro !== null && typeof primeiro === 'object') {
      const opcoes = primeiro as { port?: unknown; host?: unknown; path?: unknown; fd?: unknown };
      if (opcoes.port === 0 && !opcoes.host && !opcoes.path && opcoes.fd === undefined) {
        return ligarEmLoopbackSincrono(this, original, args.slice(1));
      }
    }

    return original.apply(this, args);
  };
  proto[MARCA] = true;
}

prenderServidoresAoLoopback();
