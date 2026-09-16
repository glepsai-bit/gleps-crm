/**
 * Marcador de build — responde "qual commit está no ar?" em dois segundos.
 *
 * Nasceu de um deploy em que o backend subiu com o código novo e o frontend
 * ficou no anterior. Não havia como saber olhando a tela: a única forma foi
 * comparar item de menu com o código. Agora o próprio rodapé responde.
 *
 * `__BUILD_COMMIT__` e `__BUILD_TIME__` são injetados em tempo de build pelo
 * `define` do vite.config.ts.
 */
export const BUILD_COMMIT = __BUILD_COMMIT__;
export const BUILD_TIME = __BUILD_TIME__;

const quando = (() => {
  const d = new Date(BUILD_TIME);
  return Number.isNaN(d.getTime())
    ? BUILD_TIME
    : d.toLocaleString('pt-BR', {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
})();

/** `15d2be7 · 16/09, 04:20` — ou `build 16/09, 04:20` quando não há commit. */
export const BUILD_LABEL =
  BUILD_COMMIT === 'local' ? `build ${quando}` : `${BUILD_COMMIT} · ${quando}`;

/** Data completa no hover: fuso explícito, pra colar em conversa sem ambiguidade. */
export const BUILD_TITLE = `commit ${BUILD_COMMIT} · build ${BUILD_TIME}`;
