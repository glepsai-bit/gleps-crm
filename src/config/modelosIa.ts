/**
 * Catálogo de modelos de IA — a fonte ÚNICA das duas telas de agente
 * (`PainelAgente`, no canvas, e `AdminIaAgentesPage`). Cada tela tinha a sua
 * lista escrita à mão, e a OpenAI só oferecia gpt-4o-mini e gpt-4o.
 *
 * O backend aceita QUALQUER id de modelo (e confere contra a chave da conta ao
 * salvar): o catálogo é só o que a tela sugere. Quem precisa de um id fora
 * dele usa "Outro modelo…".
 *
 * Preço em US$ por 1 milhão de tokens. O backend tem a própria tabela de
 * preços em `backend/src/services/ai/chat.ts`; aqui o número serve para o
 * admin comparar antes de escolher, não para cobrança.
 */
import type { AiProviderName, NivelDeRaciocinio } from '@/services/ai.backend.service';

export interface ModeloIa {
  /** O id que vai para a API do provedor. */
  id: string;
  /** Para que serve; entra no rótulo depois do id: "gpt-4.1 — recomendado para venda". */
  uso?: string;
  /** US$ por 1M tokens de entrada. */
  entrada: number;
  /** US$ por 1M tokens de saída. */
  saida: number;
  /** Raciocina antes de responder — aceita o nível de `raciocinio`. */
  raciocinio?: boolean;
}

export const MODELOS_IA: Record<AiProviderName, ModeloIa[]> = {
  openai: [
    { id: 'gpt-4.1', uso: 'recomendado para venda', entrada: 2, saida: 8 },
    { id: 'gpt-5-mini', uso: 'custo-benefício, raciocínio', entrada: 0.25, saida: 2, raciocinio: true },
    { id: 'gpt-5', uso: 'máxima qualidade, raciocínio', entrada: 1.25, saida: 10, raciocinio: true },
    { id: 'gpt-4.1-mini', uso: 'rápido', entrada: 0.4, saida: 1.6 },
    { id: 'gpt-5-nano', uso: 'mais barato com raciocínio', entrada: 0.05, saida: 0.4, raciocinio: true },
    { id: 'gpt-4o-mini', uso: 'mais barato, fraco para venda', entrada: 0.15, saida: 0.6 },
    { id: 'gpt-4o', entrada: 2.5, saida: 10 },
    { id: 'o4-mini', uso: 'raciocínio', entrada: 1.1, saida: 4.4, raciocinio: true },
  ],
  anthropic: [
    { id: 'claude-haiku-4-5', uso: 'rápido e barato', entrada: 1, saida: 5 },
    { id: 'claude-sonnet-5', uso: 'equilíbrio', entrada: 3, saida: 15 },
    { id: 'claude-opus-5', uso: 'mais capaz', entrada: 5, saida: 25 },
  ],
};

/**
 * O que roda quando o agente não escolhe modelo. Espelha `DEFAULT_MODEL` de
 * `backend/src/services/ai/chat.ts` — a Anthropic usa o id com a data da versão.
 */
export const PADRAO_DO_PROVEDOR: Record<AiProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5-20251001',
};

/** "gpt-4.1 — recomendado para venda" (ou só o id, quando não há uso a dizer). */
export function rotuloDoModelo(modelo: ModeloIa): string {
  return modelo.uso ? `${modelo.id} — ${modelo.uso}` : modelo.id;
}

/** O modelo do catálogo com este id exato, ou `null` (é o que a tela chama de "outro"). */
export function modeloDoCatalogo(provider: AiProviderName, id: string): ModeloIa | null {
  const alvo = id.trim();
  return MODELOS_IA[provider].find((m) => m.id === alvo) ?? null;
}

// `claude-haiku-4-5-20251001` e `gpt-4o-2024-08-06` são o modelo do catálogo com
// o carimbo da versão no fim — só para achar o PREÇO; a seleção é pelo id exato.
const CARIMBO_DE_VERSAO = /-(\d{8}|\d{4}-\d{2}-\d{2})$/;

const dinheiro = new Intl.NumberFormat('pt-BR', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * "US$ 2,00 entrada / 8,00 saída por 1M tokens" do modelo, ou `null` quando
 * ele não está no catálogo (id digitado à mão) e portanto não tem preço.
 * Id vazio = o padrão do provedor, que é o modelo que de fato vai rodar.
 */
export function textoDoPreco(provider: AiProviderName, id: string): string | null {
  const alvo = id.trim() || PADRAO_DO_PROVEDOR[provider];
  const modelo =
    modeloDoCatalogo(provider, alvo) ?? modeloDoCatalogo(provider, alvo.replace(CARIMBO_DE_VERSAO, ''));
  if (!modelo) return null;
  return `US$ ${dinheiro.format(modelo.entrada)} entrada / ${dinheiro.format(modelo.saida)} saída por 1M tokens`;
}

/**
 * Modelo que raciocina antes de responder: todo gpt-5* e a série o1..o9. Vale
 * também para o id digitado em "Outro modelo…" (gpt-5.1, gpt-5.1-mini…).
 * Mesma regra do backend (`ehModeloDeRaciocinio` em `services/ai/chat.ts`),
 * que só manda `reasoning_effort` para estes — para os outros a OpenAI dá 400.
 */
export function ehModeloDeRaciocinio(model: string | null | undefined): boolean {
  return !!model && /^(gpt-5|o[1-9])/.test(model.trim().toLowerCase());
}

export const NIVEIS_DE_RACIOCINIO: { valor: NivelDeRaciocinio; rotulo: string }[] = [
  { valor: 'minimal', rotulo: 'Mínimo' },
  { valor: 'low', rotulo: 'Baixo' },
  { valor: 'medium', rotulo: 'Médio' },
  { valor: 'high', rotulo: 'Alto' },
];

/** O nível que o seletor mostra (e salva) enquanto ninguém escolheu outro. */
export const RACIOCINIO_PADRAO: NivelDeRaciocinio = 'low';

/**
 * O `raciocinio` que vai no payload do agente: o nível escolhido (ou o padrão)
 * nos modelos de raciocínio, `null` em todos os outros. O nível fica guardado
 * na tela mesmo escondido, então ir e voltar de gpt-5 para gpt-4.1 não o perde.
 */
export function raciocinioParaSalvar(
  model: string | null | undefined,
  nivel: NivelDeRaciocinio | null | undefined
): NivelDeRaciocinio | null {
  return ehModeloDeRaciocinio(model) ? (nivel ?? RACIOCINIO_PADRAO) : null;
}
