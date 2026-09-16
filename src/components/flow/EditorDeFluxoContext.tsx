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
  /** Abre o editor ampliado (o prompt, que não cabe no bloco). */
  ampliar: (nodeId: string) => void;
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
