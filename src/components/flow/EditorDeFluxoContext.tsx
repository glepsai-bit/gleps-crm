/**
 * T-037 — a ponte entre o bloco e o editor.
 *
 * O bloco precisa gravar configuração, mas o callback NÃO pode ir dentro de
 * `node.data`: esse objeto é serializado direto pro backend em `paraGrafo()`,
 * e função ali quebraria o salvamento e a memoização junto.
 *
 * Contexto + `useNodeId()` resolve os dois: o bloco descobre quem é por conta
 * própria, `data` continua sendo só dado, e o callback é estável.
 */
import { createContext, useContext } from 'react';

export interface EditorDeFluxo {
  /** Grava uma chave da configuração do bloco. */
  setConfig: (nodeId: string, chave: string, valor: unknown) => void;
  /** Renomeia o passo. */
  setLabel: (nodeId: string, label: string) => void;
  /** Abre ou fecha os campos do bloco. */
  alternarAberto: (nodeId: string) => void;
  /** Remove o bloco. Com `deleteKeyCode` desligado, é o único caminho. */
  remover: (nodeId: string) => void;
  /**
   * Remove uma ligação.
   *
   * Mesmo motivo do `remover`: com `deleteKeyCode` desligado (o Select do
   * shadcn é um <button role="combobox"> e o Backspace nele apagaria o bloco),
   * a tecla Delete não existe aqui. Sem este canal, uma aresta desenhada errado
   * só sumia apagando um dos dois blocos que ela liga.
   */
  removerAresta: (edgeId: string) => void;
  /** Abre o editor ampliado (o prompt, que não cabe no bloco). */
  ampliar: (nodeId: string) => void;
  /**
   * Abre a memória do agente deste bloco — o que ele guarda sobre a pessoa.
   *
   * Porta própria, e não uma aba dentro do ampliado, porque memória é a
   * pergunta "o que ele lembra?", feita em outro momento de quem monta.
   */
  abrirMemoria: (nodeId: string) => void;
  /**
   * A janela de agrupamento que está REALMENTE valendo neste fluxo.
   *
   * O campo mora no gatilho, mas fluxo salvo antes disso guarda o valor no
   * bloco `buffer.debounce`. Sem passar o valor efetivo, o gatilho mostraria o
   * padrão (15) num fluxo que agrupa em 30 — a tela mentiria.
   */
  janelaDoFluxo: number;
  agentes: { id: string; name: string }[];
  bases: { id: string; name: string }[];
  /** Blocos com os campos abertos. */
  abertos: Set<string>;
}

const Ctx = createContext<EditorDeFluxo | null>(null);

export const EditorDeFluxoContext = Ctx;

/**
 * Null fora do editor — é o caso do teste do card, que renderiza o bloco
 * isolado. Nesse caso ele cai no modo leitura, que é o comportamento certo.
 */
// Falso positivo: este arquivo não exporta componente nenhum. A regra confunde
// o objeto de contexto (nome em PascalCase) com um. Separar o hook em outro
// arquivo só pra calar o alerta espalharia a mesma coisa em dois lugares.
// eslint-disable-next-line react-refresh/only-export-components
export function useEditorDeFluxo(): EditorDeFluxo | null {
  return useContext(Ctx);
}
