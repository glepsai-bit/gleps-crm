/**
 * T-038 — o agente editado POR CIMA do canvas.
 *
 * O bloco "Atender com IA" só tinha um seletor: pra mudar uma vírgula do prompt
 * era preciso sair do fluxo, achar o agente na aba "Agentes IA", editar, voltar
 * e torcer pra ter mexido no mesmo. Este painel encerra a viagem — escolher,
 * criar, editar e excluir acontecem com o desenho ainda atrás.
 *
 * O prompt manda no layout: na vida real ele tem ~20 mil caracteres, então fica
 * com a coluna inteira e a altura toda, e o resto da configuração cabe numa
 * trilha estreita ao lado. Antes ele era um campinho de quatro linhas no meio
 * de um formulário.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Bot,
  Brain,
  Columns3,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  Sparkles,
  Trash2,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import {
  aiService,
  type AiAgentInput,
  type AiProviderName,
} from '@/services/ai.backend.service';
import { useEtapasDoFunil, useTimesDaConta } from './CamposDoNo';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { rotuloDaPorta } from './portas';

interface Props {
  agentId: string | null;
  onEscolher: (id: string) => void;
  onFechar: () => void;
}

/** As saídas que todo atendimento tem — o bloco desenha estas mesmo sem rota. */
const ROTAS_FIXAS: string[] = ['respondeu', 'humano', 'encerrou'];

/**
 * Os campos que o bloco "Atender com IA" LÊ da resposta do agente
 * (`backend/src/services/flow/nodes.ts`): `etapa` é a etiqueta que ele aplica
 * sozinho no funil, e os outros dois decidem "humano" e "encerrou". No modo
 * estrito ele fecha o objeto com `additionalProperties: false`, então campo que
 * não está no formato é campo que o modelo fica PROIBIDO de emitir.
 */
const SINAIS_DE_SAIDA: string[] = ['etapa', 'transferir_para_humano', 'resolver_conversa'];

/** O aviso precisa dizer o que exatamente para de funcionar sem cada sinal. */
const CONSEQUENCIA_SEM_SINAL: Record<string, string> = {
  etapa: 'a etapa deixa de subir pro funil',
  transferir_para_humano: 'a saída humano fica morta',
  resolver_conversa: 'a saída encerrou fica morta',
};

/**
 * Memória de longo prazo vale por 60 dias — `MEMORIA_LONGA_DIAS` em
 * `backend/src/services/ai/memoria.ts`. Repetido aqui porque a frase do painel
 * precisa do número, e o número é uma decisão de produto, não de rede.
 */
const MEMORIA_LONGA_DIAS = 60;

/** Memória é nativa: `lembrar` vai sempre ao modelo, então não é um toggle. */
const FERRAMENTA_DE_MEMORIA = 'lembrar';
const FERRAMENTA_DE_BASE = 'buscar_conhecimento';

/** "a, b e c" — enumeração em frase, sem lista solta no meio do texto. */
function emFrase(itens: string[]): string {
  if (itens.length < 2) return itens[0] ?? '';
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

// Modelos que rejeitam `temperature` com erro 400 (Claude 4.7+ / família 5).
// O backend remove o campo antes de enviar; aqui o aviso evita ajustar um
// controle que não faz nada.
const SEM_TEMPERATURA = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-5',
  'claude-fable-5',
];

const MODELOS: Record<AiProviderName, { value: string; label: string }[]> = {
  openai: [
    { value: 'gpt-4o-mini', label: 'gpt-4o-mini — rápido e barato' },
    { value: 'gpt-4o', label: 'gpt-4o — mais capaz' },
  ],
  anthropic: [
    { value: 'claude-haiku-4-5', label: 'claude-haiku-4-5 — rápido e barato' },
    { value: 'claude-sonnet-5', label: 'claude-sonnet-5 — equilíbrio' },
    { value: 'claude-opus-5', label: 'claude-opus-5 — mais capaz' },
  ],
};

type CampoNumerico = 'temperature' | 'maxTokens' | 'historyLimit';

/**
 * As mesmas faixas do zod em `backend/src/controllers/ai.controller.ts`.
 * Repetir aqui é o que evita o erro do servidor chegar cru e em inglês no toast.
 */
const FAIXAS: Record<CampoNumerico, { rotulo: string; min: number; max: number; inteiro: boolean; padrao: string }> = {
  temperature: { rotulo: 'Criatividade', min: 0, max: 2, inteiro: false, padrao: '0.7' },
  maxTokens: { rotulo: 'Resposta máx.', min: 64, max: 32000, inteiro: true, padrao: '1024' },
  historyLimit: { rotulo: 'Histórico', min: 0, max: 60, inteiro: true, padrao: '20' },
};

/**
 * Sem `role` de propósito: o backend nunca leu o papel — quem manda é o prompt
 * e o formato da resposta. O campo existia só na tela, e confundia.
 */
interface Rascunho {
  name: string;
  description: string;
  systemPrompt: string;
  provider: AiProviderName;
  model: string;
  /**
   * Os três numéricos ficam como TEXTO: apagar "1024" pra digitar "2048" passa
   * por um instante vazio, e `Number('')` é 0 — o campo travava no zero.
   */
  temperature: string;
  maxTokens: string;
  historyLimit: string;
  knowledgeBaseId: string | null;
  tools: string[];
  subAgentIds: string[];
  active: boolean;
}

const RASCUNHO_VAZIO: Rascunho = {
  name: '',
  description: '',
  systemPrompt: '',
  provider: 'openai',
  model: '',
  temperature: FAIXAS.temperature.padrao,
  maxTokens: FAIXAS.maxTokens.padrao,
  historyLimit: FAIXAS.historyLimit.padrao,
  knowledgeBaseId: null,
  tools: [],
  subAgentIds: [],
  active: true,
};

function lerNumero(texto: string): number | null {
  // Vírgula decimal: em teclado pt-BR é o que sai naturalmente de "0,7".
  const limpo = texto.trim().replace(',', '.');
  if (!limpo) return null;
  const numero = Number(limpo);
  return Number.isFinite(numero) ? numero : null;
}

function textoDeNumero(valor: string | number, padrao: string): string {
  const numero = Number(valor);
  return Number.isFinite(numero) ? String(numero) : padrao;
}

/** Devolve o valor preso na faixa — usado no blur, nunca durante a digitação. */
function dentroDaFaixa(campo: CampoNumerico, texto: string): string {
  const faixa = FAIXAS[campo];
  const numero = lerNumero(texto);
  if (numero === null) return faixa.padrao;
  const preso = Math.min(faixa.max, Math.max(faixa.min, numero));
  return String(faixa.inteiro ? Math.round(preso) : preso);
}

/**
 * O formato da resposta do agente.
 *
 * Fica como TEXTO no estado, e não como objeto: o texto é a única forma que
 * sobrevive ao usuário digitando um JSON pela metade no modo avançado. As
 * rotas (e o "quando usar" de cada uma) são uma LEITURA desse texto — nunca um
 * segundo estado, senão os dois divergem na primeira edição manual.
 */
interface EsquemaSaida {
  properties?: Record<string, unknown>;
  required?: unknown;
  [chave: string]: unknown;
}

/**
 * A propriedade `etapa` com as etapas REAIS do funil. Sem etapa cadastrada não
 * há enum — e em runtime o backend nem envia a propriedade ao modelo, pra ele
 * não inventar uma etapa que o Kanban não tem.
 */
function propriedadeEtapa(etapas: string[]): Record<string, unknown> {
  return {
    type: 'string',
    ...(etapas.length > 0 ? { enum: etapas } : {}),
    description: 'Etapa do funil que melhor descreve a conversa agora (use o nome exato).',
  };
}

/** Espelha `buildSuggestedAgentSchema` de `backend/src/services/flow/default-graph.ts`. */
function esquemaPadrao(etapas: string[]): EsquemaSaida {
  return {
    type: 'object',
    properties: {
      mensagem_de_resposta: { type: 'string', description: 'O que enviar ao lead.' },
      etapa: propriedadeEtapa(etapas),
      transferir_para_humano: {
        type: 'boolean',
        description: 'true quando o lead pede atendente humano ou o caso sai do script.',
      },
      resolver_conversa: {
        type: 'boolean',
        description: 'true quando o atendimento terminou e nada mais é esperado.',
      },
    },
    required: ['mensagem_de_resposta', 'etapa', 'transferir_para_humano'],
  };
}

/**
 * Reescreve o enum de `etapa` com as etapas reais da conta.
 *
 * Um formato gravado antes trazia seis slugs fixos que não existiam em conta
 * nenhuma. O backend já substitui em toda execução; aqui é pra que o que fica
 * SALVO seja o que o funil tem — e o modo avançado não mostre uma lista falsa.
 * `etapas === null` significa "ainda não sei quais são": não mexe.
 */
function comEtapasReais(esquema: EsquemaSaida | null, etapas: string[] | null): EsquemaSaida | null {
  if (!esquema || !etapas) return esquema;
  const props = esquema.properties;
  const etapa = props?.etapa;
  if (!props || !etapa || typeof etapa !== 'object') return esquema;
  const nova: Record<string, unknown> = { ...(etapa as Record<string, unknown>), type: 'string' };
  delete nova.enum;
  if (etapas.length > 0) nova.enum = etapas;
  return { ...esquema, properties: { ...props, etapa: nova } };
}

function lerEsquema(texto: string): { esquema: EsquemaSaida | null; erro: string | null } {
  const limpo = texto.trim();
  if (!limpo) return { esquema: null, erro: null };
  try {
    const valor: unknown = JSON.parse(limpo);
    if (!valor || typeof valor !== 'object' || Array.isArray(valor)) {
      return { esquema: null, erro: 'O formato da resposta precisa ser um bloco de campos.' };
    }
    return { esquema: valor as EsquemaSaida, erro: null };
  } catch {
    return {
      esquema: null,
      erro: 'Não consegui ler o formato da resposta — confira o texto em "Ver o formato da resposta".',
    };
  }
}

function propriedadeRota(esquema: EsquemaSaida | null): Record<string, unknown> | null {
  const rota = esquema?.properties?.rota;
  return rota && typeof rota === 'object' ? (rota as Record<string, unknown>) : null;
}

/** Só as rotas do usuário: as fixas viram chip próprio e não se removem. */
function rotasDo(esquema: EsquemaSaida | null): string[] {
  const lista = propriedadeRota(esquema)?.enum;
  if (!Array.isArray(lista)) return [];
  return lista.filter((r): r is string => typeof r === 'string' && !ROTAS_FIXAS.includes(r));
}

/**
 * O "quando usar" de cada rota mora na DESCRIÇÃO de `rota` — é o texto que o
 * modelo lê pra decidir, então é lá que a instrução precisa estar. Formato
 * estável, uma rota por linha, depois da frase padrão:
 *
 *   Por onde a conversa segue. Use respondeu, humano ou encerrou quando for um atendimento comum.
 *   - financeiro: boleto, nota fiscal, cobrança
 *   - suporte: problema técnico no que já comprou
 */
const FRASE_DA_ROTA =
  'Por onde a conversa segue. Use respondeu, humano ou encerrou quando for um atendimento comum.';

// O texto depois de ": " NÃO é aparado na leitura: o campo é editado tecla a
// tecla, e aparar aqui comeria o espaço que o usuário acabou de digitar.
const LINHA_QUANDO_USAR = /^-\s*([^:\s]+):\s?(.*)$/;

function quandoUsarDo(esquema: EsquemaSaida | null): Record<string, string> {
  const descricao = propriedadeRota(esquema)?.description;
  if (typeof descricao !== 'string') return {};
  const mapa: Record<string, string> = {};
  for (const linha of descricao.split('\n')) {
    const m = LINHA_QUANDO_USAR.exec(linha);
    if (m && m[2].trim()) mapa[m[1]] = m[2];
  }
  return mapa;
}

function descricaoDaRota(rotas: string[], quando: Record<string, string>): string {
  const linhas = rotas
    .filter((r) => (quando[r] ?? '').trim() !== '')
    .map((r) => `- ${r}: ${quando[r]}`);
  return linhas.length > 0 ? `${FRASE_DA_ROTA}\n${linhas.join('\n')}` : FRASE_DA_ROTA;
}

/**
 * As saídas fixas que o enum de `rota` esqueceu.
 *
 * Os chips só produzem enum completo, mas um formato escrito à mão (aqui no modo
 * avançado ou vindo da tela antiga de agentes) pode listar só os desvios. Aí o
 * modelo fica PROIBIDO de dizer respondeu/humano/encerrou, e o bloco resolve a
 * saída por `rota` antes de olhar qualquer outro campo: toda conversa passa a
 * sair pelo desvio. Como as fixas não viram chip, isso não aparece na lista.
 */
function rotasFixasFaltando(esquema: EsquemaSaida | null): string[] {
  const lista = propriedadeRota(esquema)?.enum;
  if (!Array.isArray(lista)) return [];
  return ROTAS_FIXAS.filter((fixa) => !lista.includes(fixa));
}

/** Campos que o bloco lê e o formato não declara — logo, proibidos ao modelo. */
function sinaisFaltando(esquema: EsquemaSaida | null): string[] {
  const props = esquema?.properties;
  if (!props || typeof props !== 'object') return [];
  return SINAIS_DE_SAIDA.filter((sinal) => !(sinal in props));
}

function comRotas(
  esquema: EsquemaSaida | null,
  rotas: string[],
  quando: Record<string, string>,
  etapas: string[]
): EsquemaSaida | null {
  if (!esquema && rotas.length === 0) return null;
  const base: EsquemaSaida = esquema ? { ...esquema } : esquemaPadrao(etapas);
  const props: Record<string, unknown> = { ...(base.properties ?? {}) };
  const obrigatorios = (Array.isArray(base.required) ? base.required : []).filter(
    (campo): campo is string => typeof campo === 'string'
  );

  if (rotas.length === 0) {
    delete props.rota;
  } else {
    const anterior =
      typeof props.rota === 'object' && props.rota !== null
        ? (props.rota as Record<string, unknown>)
        : {};
    props.rota = {
      ...anterior,
      type: 'string',
      // O enum vai COMPLETO — as fixas na frente das do usuário. O backend
      // resolve a saída por `rota` ANTES de olhar transferir_para_humano e
      // resolver_conversa; com enum só das novas, toda conversa sairia por
      // elas e as três portas de sempre morreriam.
      enum: [...ROTAS_FIXAS, ...rotas],
      description: descricaoDaRota(rotas, quando),
    };
  }

  // `rota` nunca é obrigatória: exigida, o modelo tem que escolher um desvio
  // em toda mensagem, mesmo nas que só precisavam de resposta.
  base.required = obrigatorios.filter((campo) => campo !== 'rota');
  base.properties = props;
  return base;
}

/** Nome de rota vira handle de saída no canvas — sem acento, espaço nem maiúscula. */
function normalizarRota(valor: string): string {
  return valor
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function PainelAgente({ agentId, onEscolher, onFechar }: Props) {
  const qc = useQueryClient();

  // Mesma chave que o canvas usa: assim a lista já está em cache quando o
  // painel abre, e o bloco enxerga o agente salvo sem um segundo request.
  const agentesQuery = useQuery({ queryKey: ['ai-agents'], queryFn: aiService.listAgents });
  const statusQuery = useQuery({ queryKey: ['ai', 'status'], queryFn: aiService.getStatus });
  const etapasQuery = useEtapasDoFunil();
  const timesQuery = useTimesDaConta();

  const [rascunho, setRascunho] = useState<Rascunho>(RASCUNHO_VAZIO);
  const [esquemaTexto, setEsquemaTexto] = useState('');
  const [criando, setCriando] = useState(false);
  const [sujo, setSujo] = useState(false);
  const [novaRota, setNovaRota] = useState('');
  const [avancado, setAvancado] = useState(false);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState(false);

  const agentes = agentesQuery.data ?? [];
  const agente = agentes.find((a) => a.id === agentId) ?? null;
  const status = statusQuery.data;
  const etapas = useMemo(() => etapasQuery.data ?? [], [etapasQuery.data]);
  // `null` enquanto não se sabe: o enum gravado só é reescrito com certeza.
  const slugsDasEtapas = useMemo(
    () => (etapasQuery.data ? etapasQuery.data.map((e) => e.slug) : null),
    [etapasQuery.data]
  );

  // Hidrata uma vez por agente. Depender do objeto inteiro faria o refetch da
  // lista (a cada foco na janela) pisar no prompt no meio da digitação.
  const carregado = useRef<string | null>(null);
  useEffect(() => {
    if (criando || !agente || carregado.current === agente.id) return;
    carregado.current = agente.id;
    setRascunho({
      name: agente.name,
      description: agente.description ?? '',
      systemPrompt: agente.systemPrompt,
      provider: agente.provider,
      model: agente.model ?? '',
      temperature: textoDeNumero(agente.temperature, FAIXAS.temperature.padrao),
      maxTokens: textoDeNumero(agente.maxTokens, FAIXAS.maxTokens.padrao),
      historyLimit: textoDeNumero(agente.historyLimit, FAIXAS.historyLimit.padrao),
      knowledgeBaseId: agente.knowledgeBaseId,
      tools: agente.tools ?? [],
      subAgentIds: agente.subAgentIds ?? [],
      active: agente.active,
    });
    setEsquemaTexto(agente.outputSchema ? JSON.stringify(agente.outputSchema, null, 2) : '');
    setSujo(false);
    setAvancado(false);
    setConfirmandoExclusao(false);
  }, [agente, criando]);

  const { esquema, erro: erroEsquema } = useMemo(() => lerEsquema(esquemaTexto), [esquemaTexto]);
  const rotas = useMemo(() => rotasDo(esquema), [esquema]);
  const quandoUsar = useMemo(() => quandoUsarDo(esquema), [esquema]);
  const faltamSinais = useMemo(() => sinaisFaltando(esquema), [esquema]);
  const faltamFixas = useMemo(() => rotasFixasFaltando(esquema), [esquema]);

  const editar = (mudanca: Partial<Rascunho>) => {
    setRascunho((r) => ({ ...r, ...mudanca }));
    setSujo(true);
  };

  const ajustarNumero = (campo: CampoNumerico) => {
    const corrigido = dentroDaFaixa(campo, rascunho[campo]);
    if (corrigido !== rascunho[campo]) editar({ [campo]: corrigido } as Partial<Rascunho>);
  };

  const editarEsquema = (texto: string) => {
    setEsquemaTexto(texto);
    setSujo(true);
  };

  const aplicarRotas = (lista: string[], quando: Record<string, string> = quandoUsar) => {
    const novo = comRotas(esquema, lista, quando, slugsDasEtapas ?? []);
    editarEsquema(novo ? JSON.stringify(novo, null, 2) : '');
  };

  /** Uma rota nova, venha do campo de texto ou de um chip de time. */
  const incluirRota = (bruto: string) => {
    const nome = normalizarRota(bruto);
    if (!nome) return false;
    if (ROTAS_FIXAS.includes(nome)) {
      toast.error(`"${nome}" já é uma saída fixa do bloco.`);
      return false;
    }
    if (!rotas.includes(nome)) aplicarRotas([...rotas, nome]);
    return true;
  };

  const adicionarRotaDigitada = () => {
    if (incluirRota(novaRota)) setNovaRota('');
  };

  const editarQuandoUsar = (rota: string, texto: string) =>
    aplicarRotas(rotas, { ...quandoUsar, [rota]: texto });

  /**
   * Devolve as saídas fixas ao enum passando pelo mesmo `aplicarRotas` dos chips
   * — é ele que reescreve o enum como [fixas, ...as do usuário]. Se não sobrou
   * rota própria, o campo `rota` sai do formato: sem desvio pra escolher ele não
   * tem função, e as três saídas o bloco desenha de qualquer jeito.
   */
  const reporRotasFixas = () => aplicarRotas(rotas);

  const incluirSinaisQueFaltam = () => {
    if (!esquema) return;
    const padrao = esquemaPadrao(slugsDasEtapas ?? []).properties ?? {};
    const props: Record<string, unknown> = { ...(esquema.properties ?? {}) };
    for (const sinal of faltamSinais) props[sinal] = padrao[sinal];
    editarEsquema(JSON.stringify({ ...esquema, properties: props }, null, 2));
  };

  const podeSair = () =>
    !sujo ||
    window.confirm('Você mexeu no agente e não salvou. Sair agora descarta o que escreveu.');

  const comecarNovo = () => {
    // Sem o status não dá pra escolher o provedor: numa conta que só tem
    // Anthropic, o padrão 'openai' criaria um agente que não roda.
    if (statusQuery.isLoading) {
      toast.info('Um instante — ainda estou vendo quais provedores esta conta tem.');
      return;
    }
    if (!podeSair()) return;
    carregado.current = null;
    setCriando(true);
    setSujo(false);
    setAvancado(false);
    setConfirmandoExclusao(false);
    setEsquemaTexto('');
    setRascunho({
      ...RASCUNHO_VAZIO,
      provider: status && !status.providers.openai && status.providers.anthropic ? 'anthropic' : 'openai',
    });
  };

  const trocarAgente = (id: string) => {
    if (!podeSair()) return;
    carregado.current = null;
    setSujo(false);
    setConfirmandoExclusao(false);
    onEscolher(id);
  };

  const fechar = () => {
    if (podeSair()) onFechar();
  };

  const salvar = useMutation({
    mutationFn: (numeros: Record<CampoNumerico, number>) => {
      // O `etapa.enum` que vai pro banco é o do funil real — nunca uma lista
      // que o painel inventou. Sem `role`: o backend ignora, e a tela parou de
      // fingir que o campo decidia algo.
      const formato = comEtapasReais(esquema, slugsDasEtapas);
      const payload: AiAgentInput = {
        name: rascunho.name.trim(),
        description: rascunho.description.trim() || null,
        systemPrompt: rascunho.systemPrompt,
        provider: rascunho.provider,
        model: rascunho.model.trim() || null,
        temperature: numeros.temperature,
        maxTokens: numeros.maxTokens,
        historyLimit: numeros.historyLimit,
        tools: rascunho.tools,
        subAgentIds: rascunho.subAgentIds,
        outputSchema: (formato as Record<string, unknown> | null) ?? null,
        active: rascunho.active,
      };
      return criando || !agentId
        ? aiService.createAgent(payload)
        : aiService.updateAgent(agentId, payload);
    },
    onSuccess: (salvo) => {
      // Duas chaves de propósito: o canvas lê 'ai-agents' (é de lá que saem as
      // portas do bloco) e a página de agentes lê ['ai','agents']. Invalidar só
      // uma deixa a outra tela mostrando o prompt velho.
      qc.invalidateQueries({ queryKey: ['ai-agents'] });
      qc.invalidateQueries({ queryKey: ['ai', 'agents'] });
      carregado.current = salvo.id;
      setCriando(false);
      setSujo(false);
      if (salvo.id !== agentId) onEscolher(salvo.id);
      toast.success(
        criando ? 'Agente criado e ligado neste passo' : 'Agente salvo',
        rotas.length > 0
          ? { description: 'As saídas do bloco já refletem as rotas.' }
          : undefined
      );
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível salvar o agente'),
  });

  const excluir = useMutation({
    mutationFn: (id: string) => aiService.deleteAgent(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ai-agents'] });
      qc.invalidateQueries({ queryKey: ['ai', 'agents'] });
      carregado.current = null;
      setConfirmandoExclusao(false);
      setCriando(false);
      setSujo(false);
      setRascunho(RASCUNHO_VAZIO);
      setEsquemaTexto('');
      toast.success('Agente excluído', {
        description: 'Este passo ficou sem agente — escolha outro ou crie um novo.',
      });
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível excluir o agente'),
  });

  const enviar = () => {
    if (!rascunho.name.trim()) {
      toast.error('Dê um nome ao agente');
      return;
    }
    if (!rascunho.systemPrompt.trim()) {
      toast.error('O prompt é o agente — escreva antes de salvar.');
      return;
    }
    if (erroEsquema) {
      toast.error('O formato da resposta está com erro', { description: erroEsquema });
      setAvancado(true);
      return;
    }

    // Conferir a faixa aqui é o que troca o "Number must be greater than or
    // equal to 64" do zod por uma frase que o usuário entende.
    const numeros: Record<CampoNumerico, number> = { temperature: 0, maxTokens: 0, historyLimit: 0 };
    for (const campo of Object.keys(FAIXAS) as CampoNumerico[]) {
      const faixa = FAIXAS[campo];
      const numero = lerNumero(rascunho[campo]);
      if (numero === null || numero < faixa.min || numero > faixa.max) {
        toast.error(
          `${faixa.rotulo} precisa ser um número entre ${faixa.min.toLocaleString('pt-BR')} e ${faixa.max.toLocaleString('pt-BR')}.`
        );
        return;
      }
      if (faixa.inteiro && !Number.isInteger(numero)) {
        toast.error(`${faixa.rotulo} precisa ser um número inteiro.`);
        return;
      }
      numeros[campo] = numero;
    }

    salvar.mutate(numeros);
  };

  const semTemperatura = SEM_TEMPERATURA.some((p) => rascunho.model.startsWith(p));
  const especialistas = agentes.filter((a) => a.id !== agentId);
  const editando = criando || !!agente;
  const listaQuebrou = agentesQuery.isError;
  const carregando = agentesQuery.isLoading && !!agentId;
  // O passo aponta pra um agente que a lista (já carregada, sem erro) não tem:
  // foi excluído. Não é a mesma coisa que "nenhum agente configurado".
  const agenteSumiu = !!agentId && !agente && !criando && !agentesQuery.isLoading && !listaQuebrou;

  // `lembrar` sai da lista: é nativa, não se liga nem desliga.
  const ferramentas = (status?.tools ?? []).filter((t) => t.name !== FERRAMENTA_DE_MEMORIA);
  // Base vem da linha do canvas, não deste painel — por isso lê o agente salvo.
  // Em "criando", `agente` ainda é o do passo (o antigo), então não conta.
  const baseLigada = criando ? null : (agente?.knowledgeBase ?? null);
  const temBase = criando ? false : !!(agente?.knowledgeBaseId || baseLigada);
  const buscaSemBase = rascunho.tools.includes(FERRAMENTA_DE_BASE) && !temBase;

  // Times viram sugestão de rota: um clique cria "financeiro" a partir do
  // time Financeiro. Os que já são rota (ou colidem com fixa) não aparecem.
  const sugestoesDeTime = (timesQuery.data ?? [])
    .map((t) => ({ id: t.id, nome: t.name, rota: normalizarRota(t.name) }))
    .filter((t) => t.rota && !rotas.includes(t.rota) && !ROTAS_FIXAS.includes(t.rota));

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fechar()}>
      <DialogContent className="sm:max-w-5xl sm:h-[92vh] sm:max-h-[92vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Bot className="w-5 h-5" /> Quem atende neste passo
            {sujo && (
              <Badge variant="outline" className="text-[10px] font-normal">
                não salvo
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            O prompt, o modelo e para onde a IA encaminha cada assunto. O que você salvar aqui
            já vale no fluxo — não precisa abrir a tela de agentes.
          </DialogDescription>
        </DialogHeader>

        {/* Escolher / criar */}
        <div className="shrink-0 flex flex-col sm:flex-row sm:items-end gap-2">
          <div className="flex-1 min-w-0 space-y-1.5">
            <Label htmlFor="pa-agente" className="text-xs">
              Agente
            </Label>
            {criando ? (
              <div className="h-10 flex items-center gap-2 rounded-md border border-dashed px-3 text-sm text-muted-foreground">
                <Sparkles className="w-4 h-4 shrink-0" />
                <span className="truncate">Agente novo — dê um nome e escreva o prompt</span>
              </div>
            ) : (
              <Select
                value={agente?.id ?? undefined}
                onValueChange={trocarAgente}
                disabled={listaQuebrou || agentesQuery.isLoading}
              >
                <SelectTrigger id="pa-agente">
                  <SelectValue
                    placeholder={
                      listaQuebrou
                        ? 'Não consegui carregar a lista'
                        : agentes.length
                          ? 'Escolha o agente deste passo'
                          : 'Nenhum agente criado ainda'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {agentes.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name}
                      {!a.active && ' — inativo'}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          {criando ? (
            <Button
              variant="ghost"
              onClick={() => {
                setCriando(false);
                setSujo(false);
              }}
            >
              Cancelar
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={comecarNovo}
              disabled={listaQuebrou || statusQuery.isLoading}
            >
              {statusQuery.isLoading ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1.5" />
              )}
              Criar agente
            </Button>
          )}
        </div>

        {status && !status.providers.openai && !status.providers.anthropic && (
          <div className="shrink-0 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-[11px] leading-relaxed">
            Esta conta não tem chave de IA cadastrada. Dá pra escrever o agente, mas ele só roda
            depois que a chave entrar em <strong>Administração → Integrações</strong>.
          </div>
        )}

        {statusQuery.isError && (
          <div className="shrink-0 rounded-md border bg-muted/50 p-2.5 text-[11px] leading-relaxed">
            Não consegui conferir as chaves e as ferramentas desta conta. Dá pra editar o agente,
            mas confira o provedor antes de salvar.
          </div>
        )}

        {listaQuebrou ? (
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 text-center p-6">
            <AlertTriangle className="w-10 h-10 text-destructive opacity-70" />
            <div>
              <p className="font-medium">Não consegui carregar os agentes</p>
              <p className="text-sm text-muted-foreground max-w-sm mt-1">
                {agentesQuery.error?.message || 'A lista não respondeu.'} Não crie um agente
                agora: sem a lista, você criaria um duplicado do que já existe.
              </p>
            </div>
            <Button variant="outline" onClick={() => void agentesQuery.refetch()}>
              <RefreshCw className="w-4 h-4 mr-1.5" /> Tentar de novo
            </Button>
          </div>
        ) : carregando ? (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4">
            <Skeleton className="flex-1 min-h-[220px]" />
            <div className="lg:w-[340px] shrink-0 space-y-3">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          </div>
        ) : !editando ? (
          <div
            className={`flex-1 min-h-0 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed text-center p-6 ${
              agenteSumiu ? 'border-destructive/50' : ''
            }`}
          >
            {agenteSumiu ? (
              <AlertTriangle className="w-10 h-10 text-destructive opacity-70" />
            ) : (
              <Bot className="w-10 h-10 opacity-30" />
            )}
            <div>
              <p className="font-medium">
                {agenteSumiu
                  ? 'O agente deste passo não existe mais'
                  : 'Nenhum agente neste passo'}
              </p>
              <p className="text-sm text-muted-foreground max-w-sm mt-1">
                {agenteSumiu
                  ? 'Ele foi excluído. Enquanto este passo não apontar para outro agente, o fluxo para aqui em vez de responder.'
                  : 'Escolha um agente acima para editar o prompt dele aqui mesmo, ou crie um novo sem sair do fluxo.'}
              </p>
            </div>
            <Button onClick={comecarNovo} disabled={statusQuery.isLoading}>
              {statusQuery.isLoading ? (
                <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
              ) : (
                <Plus className="w-4 h-4 mr-1.5" />
              )}
              Criar agente
            </Button>
          </div>
        ) : (
          <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-4 overflow-y-auto lg:overflow-hidden">
            {/* ---- O prompt: a coluna inteira ---- */}
            <div className="flex flex-col min-h-0 gap-1.5 lg:flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="pa-prompt">Prompt do agente</Label>
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {rascunho.systemPrompt.length.toLocaleString('pt-BR')} caracteres
                </span>
              </div>
              <Textarea
                id="pa-prompt"
                spellCheck={false}
                value={rascunho.systemPrompt}
                onChange={(e) => editar({ systemPrompt: e.target.value })}
                placeholder="# PERSONA&#10;Você se chama…&#10;&#10;# REGRAS&#10;- …"
                className="flex-1 min-h-[260px] lg:min-h-0 resize-none font-mono text-xs leading-relaxed"
              />
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Use <code>{'{{variavel}}'}</code> para valores que o fluxo injeta. A lista de
                rotas ao lado cria a saída e diz em uma linha quando usá-la; o detalhe de como
                conduzir cada assunto é aqui, no prompt.
              </p>
            </div>

            {/* ---- O resto, na trilha estreita ---- */}
            <div className="lg:w-[340px] shrink-0 space-y-4 lg:overflow-y-auto lg:pr-1">
              <div className="space-y-1.5">
                <Label htmlFor="pa-nome" className="text-xs">
                  Nome
                </Label>
                <Input
                  id="pa-nome"
                  className="h-9"
                  value={rascunho.name}
                  onChange={(e) => editar({ name: e.target.value })}
                  placeholder="Marcus — SDR"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="pa-desc" className="text-xs">
                  O que ele faz
                </Label>
                <Input
                  id="pa-desc"
                  className="h-9"
                  value={rascunho.description}
                  onChange={(e) => editar({ description: e.target.value })}
                  placeholder="Qualifica lead novo de WhatsApp"
                />
                <p className="text-[11px] text-muted-foreground">
                  É por esta linha que outro agente decide quando consultar este.
                </p>
              </div>

              <Separator />

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pa-provedor" className="text-xs">
                    Provedor
                  </Label>
                  <Select
                    value={rascunho.provider}
                    onValueChange={(v) => editar({ provider: v as AiProviderName, model: '' })}
                  >
                    <SelectTrigger id="pa-provedor" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai" disabled={!!status && !status.providers.openai}>
                        OpenAI{status && !status.providers.openai ? ' (sem chave)' : ''}
                      </SelectItem>
                      <SelectItem
                        value="anthropic"
                        disabled={!!status && !status.providers.anthropic}
                      >
                        Anthropic{status && !status.providers.anthropic ? ' (sem chave)' : ''}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pa-modelo" className="text-xs">
                    Modelo
                  </Label>
                  <Select
                    value={rascunho.model || '__padrao__'}
                    onValueChange={(v) => editar({ model: v === '__padrao__' ? '' : v })}
                  >
                    <SelectTrigger id="pa-modelo" className="h-9">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__padrao__">Padrão do provedor</SelectItem>
                      {MODELOS[rascunho.provider].map((m) => (
                        <SelectItem key={m.value} value={m.value}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pa-temp" className="text-xs">
                    {FAIXAS.temperature.rotulo}
                  </Label>
                  <Input
                    id="pa-temp"
                    type="number"
                    inputMode="decimal"
                    step="0.1"
                    min={FAIXAS.temperature.min}
                    max={FAIXAS.temperature.max}
                    className="h-9"
                    disabled={semTemperatura}
                    value={rascunho.temperature}
                    onChange={(e) => editar({ temperature: e.target.value })}
                    onBlur={() => ajustarNumero('temperature')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pa-tokens" className="text-xs">
                    {FAIXAS.maxTokens.rotulo}
                  </Label>
                  <Input
                    id="pa-tokens"
                    type="number"
                    inputMode="numeric"
                    min={FAIXAS.maxTokens.min}
                    max={FAIXAS.maxTokens.max}
                    className="h-9"
                    value={rascunho.maxTokens}
                    onChange={(e) => editar({ maxTokens: e.target.value })}
                    onBlur={() => ajustarNumero('maxTokens')}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pa-hist" className="text-xs">
                    {FAIXAS.historyLimit.rotulo}
                  </Label>
                  <Input
                    id="pa-hist"
                    type="number"
                    inputMode="numeric"
                    min={FAIXAS.historyLimit.min}
                    max={FAIXAS.historyLimit.max}
                    className="h-9"
                    value={rascunho.historyLimit}
                    onChange={(e) => editar({ historyLimit: e.target.value })}
                    onBlur={() => ajustarNumero('historyLimit')}
                  />
                </div>
              </div>
              {semTemperatura && (
                <p className="text-[11px] text-muted-foreground">
                  Este modelo ignora a criatividade — o valor não é enviado.
                </p>
              )}

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <Wrench className="w-3.5 h-3.5" /> Ferramentas
                </Label>

                {/* Memória não é ferramenta que se liga: é o atendimento
                    lembrando de quem fala com ele. O toggle de `lembrar` era
                    um jeito silencioso de gravar nada. */}
                <div className="flex items-start gap-3 rounded-md border bg-muted/40 p-2.5">
                  <Brain className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="text-[11px] min-w-0">
                    <span className="font-medium block">Memória — sempre ativa</span>
                    <span className="block text-muted-foreground leading-relaxed">
                      O agente guarda o que aprende sobre a pessoa por {MEMORIA_LONGA_DIAS} dias;
                      o que ele deve guardar você declara no ícone de cérebro do bloco.
                    </span>
                  </span>
                </div>

                {statusQuery.isLoading ? (
                  <Skeleton className="h-16 w-full" />
                ) : statusQuery.isError ? (
                  <p className="text-[11px] text-destructive rounded-md border border-destructive/40 p-2.5 leading-relaxed">
                    Não consegui carregar as ferramentas. As que já estavam ligadas continuam
                    salvas — só não dá pra mexer nelas agora.
                  </p>
                ) : ferramentas.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground rounded-md border p-2.5">
                    Nenhuma outra ferramenta disponível nesta conta.
                  </p>
                ) : (
                  ferramentas.map((t) => (
                    <label
                      key={t.name}
                      className="flex items-start gap-3 rounded-md border p-2.5 cursor-pointer"
                    >
                      <Switch
                        aria-label={t.name}
                        checked={rascunho.tools.includes(t.name)}
                        onCheckedChange={(ligado) =>
                          editar({
                            tools: ligado
                              ? [...rascunho.tools, t.name]
                              : rascunho.tools.filter((x) => x !== t.name),
                          })
                        }
                      />
                      <span className="text-[11px] min-w-0">
                        <span className="font-medium font-mono block">{t.name}</span>
                        <span className="block text-muted-foreground leading-relaxed">
                          {t.description}
                        </span>
                      </span>
                    </label>
                  ))
                )}

                {/* Base NÃO tem seletor aqui de propósito: quem escolhe é a linha
                    ligada no canvas, e um seletor seria sobrescrito ao salvar o fluxo. */}
                {buscaSemBase ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed"
                  >
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      <strong>
                        <code>buscar_conhecimento</code> está ligada, mas este agente não tem
                        base
                      </strong>{' '}
                      — a busca não acha nada. Arraste o bloco{' '}
                      <strong>Base de conhecimento</strong> e ligue na entrada tracejada, na
                      lateral esquerda deste passo.
                    </span>
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    {baseLigada ? (
                      <>
                        Consulta a base <strong>{baseLigada.name}</strong>. Para trocar, ligue
                        outro bloco de base na entrada tracejada da esquerda.
                      </>
                    ) : temBase ? (
                      <>Consulta a base ligada na entrada tracejada da esquerda.</>
                    ) : (
                      <>
                        Sem base ligada. Para o agente consultar documentos, arraste um bloco de
                        base e ligue na entrada tracejada, na lateral esquerda deste passo.
                      </>
                    )}
                  </p>
                )}
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5" /> Especialistas que ele pode consultar
                </Label>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  O lead não vê a consulta, só a resposta final. Quem é consultado não consulta
                  ninguém.
                </p>
                {especialistas.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground rounded-md border p-2.5">
                    Crie outro agente para poder montar um time.
                  </p>
                ) : (
                  <div className="space-y-1.5 max-h-44 overflow-y-auto">
                    {especialistas.map((a) => (
                      <label
                        key={a.id}
                        className="flex items-start gap-2.5 rounded-md border p-2.5 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={rascunho.subAgentIds.includes(a.id)}
                          onChange={(e) =>
                            editar({
                              subAgentIds: e.target.checked
                                ? [...rascunho.subAgentIds, a.id]
                                : rascunho.subAgentIds.filter((id) => id !== a.id),
                            })
                          }
                        />
                        <span className="min-w-0">
                          <span className="text-xs font-medium block">{a.name}</span>
                          <span className="text-[11px] text-muted-foreground block">
                            {a.description || 'sem descrição — o coordenador não sabe quando chamar'}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <Separator />

              {/* Etapas: SOMENTE LEITURA. A verdade é o funil do Kanban — o
                  motor recusa qualquer etapa que não esteja nele. */}
              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <Columns3 className="w-3.5 h-3.5" /> Etapas que o agente pode aplicar
                </Label>
                {etapasQuery.isLoading ? (
                  <Skeleton className="h-8 w-full" />
                ) : etapasQuery.isError ? (
                  <p className="text-[11px] text-destructive rounded-md border border-destructive/40 p-2.5 leading-relaxed">
                    Não consegui carregar as etapas do funil. Em cada atendimento o agente usa
                    as do funil de qualquer jeito — só não dá pra mostrá-las agora.
                  </p>
                ) : etapas.length === 0 ? (
                  <div
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-amber-500/60 bg-amber-500/10 p-2.5 text-[11px] leading-relaxed"
                  >
                    <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
                    <span>
                      <strong>Seu funil não tem etapa nenhuma</strong> — o agente não vai mover
                      ninguém no Kanban. Crie as etapas no Kanban primeiro.
                    </span>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-1.5" data-testid="pa-etapas">
                    {etapas.map((e) => (
                      <Badge
                        key={e.id}
                        variant="secondary"
                        className="text-[10px] font-normal"
                        title={e.slug}
                      >
                        {e.name}
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Vêm do seu funil do Kanban. Para mudar, edite o funil.
                </p>
              </div>

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <GitBranch className="w-3.5 h-3.5" /> Para onde ele encaminha
                </Label>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Cada assunto listado aqui vira uma <strong>saída própria do bloco</strong>, pra
                  seguir por um caminho diferente do fluxo. As três primeiras todo atendimento já
                  tem.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {ROTAS_FIXAS.map((r) => (
                    /* O rótulo é o que se lê na tela; `title` guarda o valor que
                       vai no formato de resposta e na aresta. */
                    <Badge key={r} variant="secondary" className="text-[10px]" title={r}>
                      {rotuloDaPorta(r)}
                    </Badge>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Atenção: a resposta ao lead <strong>já saiu</strong> quando o bloco chega
                  nessas saídas — elas dizem o que acontece <strong>depois</strong>. Por isso
                  "Depois de responder" costuma ficar sem cabo nenhum: o atendimento acabou ali
                  e o fluxo fica esperando a próxima mensagem.
                </p>

                {rotas.length > 0 && (
                  <div className="space-y-1.5">
                    {rotas.map((r) => (
                      <div key={r} className="flex items-center gap-1.5">
                        <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                          {r}
                        </Badge>
                        <Input
                          aria-label={`Quando usar ${r}`}
                          className="h-7 text-[11px] flex-1 min-w-0"
                          placeholder="quando usar — ex.: boleto, nota fiscal, cobrança"
                          value={quandoUsar[r] ?? ''}
                          onChange={(e) => editarQuandoUsar(r, e.target.value)}
                          onBlur={() => {
                            const aparado = (quandoUsar[r] ?? '').trim();
                            if (aparado !== (quandoUsar[r] ?? '')) editarQuandoUsar(r, aparado);
                          }}
                        />
                        <button
                          type="button"
                          aria-label={`Remover ${r}`}
                          className="rounded-sm p-1 hover:bg-muted text-muted-foreground shrink-0"
                          onClick={() => aplicarRotas(rotas.filter((x) => x !== r))}
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ))}
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      O "quando usar" vai junto no formato da resposta — é o que o agente lê pra
                      escolher a rota.
                    </p>
                  </div>
                )}

                {erroEsquema ? (
                  <p className="text-[11px] text-destructive leading-relaxed">{erroEsquema}</p>
                ) : (
                  <>
                    <div className="flex gap-1.5">
                      <Input
                        className="h-8 text-xs font-mono"
                        placeholder="financeiro"
                        value={novaRota}
                        onChange={(e) => setNovaRota(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            adicionarRotaDigitada();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 shrink-0"
                        disabled={!novaRota.trim()}
                        onClick={adicionarRotaDigitada}
                      >
                        Incluir
                      </Button>
                    </div>

                    {sugestoesDeTime.length > 0 && (
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground">
                          Times da conta — um clique cria a rota:
                        </p>
                        <div className="flex flex-wrap gap-1.5">
                          {sugestoesDeTime.map((t) => (
                            <Button
                              key={t.id}
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-[11px]"
                              title={`Cria a rota "${t.rota}"`}
                              onClick={() => incluirRota(t.nome)}
                            >
                              <Plus className="w-3 h-3 mr-1" />
                              {t.nome}
                            </Button>
                          ))}
                        </div>
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Depois, no bloco <strong>Transferir para humano</strong> ligado nessa
                          saída, escolha o mesmo time.
                        </p>
                      </div>
                    )}
                  </>
                )}

                {faltamFixas.length > 0 && (
                  <p className="text-[11px] rounded-md border border-destructive/40 bg-destructive/5 p-2.5 leading-relaxed">
                    A lista de rotas deste formato não deixa o agente dizer{' '}
                    {faltamFixas.map((r) => (
                      <code key={r} className="mr-1">
                        {r}
                      </code>
                    ))}
                    — obrigado a escolher entre os desvios, ele manda toda conversa por um
                    deles, e essas saídas do bloco nunca acontecem.{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2 font-medium"
                      onClick={reporRotasFixas}
                    >
                      Repor as saídas fixas
                    </button>
                  </p>
                )}

                {faltamSinais.length > 0 && (
                  <p className="text-[11px] rounded-md border border-destructive/40 bg-destructive/5 p-2.5 leading-relaxed">
                    O formato não declara{' '}
                    {faltamSinais.map((s) => (
                      <code key={s} className="mr-1">
                        {s}
                      </code>
                    ))}
                    — campo fora do formato é campo que o agente fica proibido de emitir, então{' '}
                    {emFrase(faltamSinais.map((s) => CONSEQUENCIA_SEM_SINAL[s]).filter(Boolean))}.{' '}
                    <button
                      type="button"
                      className="underline underline-offset-2 font-medium"
                      onClick={incluirSinaisQueFaltam}
                    >
                      Incluir os campos
                    </button>
                  </p>
                )}

                <button
                  type="button"
                  className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  onClick={() => setAvancado((v) => !v)}
                >
                  {avancado ? 'Esconder o formato da resposta' : 'Ver o formato da resposta'}
                </button>

                {avancado && (
                  <div className="space-y-1.5">
                    <Textarea
                      spellCheck={false}
                      value={esquemaTexto}
                      onChange={(e) => editarEsquema(e.target.value)}
                      placeholder="(sem formato definido — o agente devolve texto livre)"
                      className="min-h-[160px] font-mono text-[11px]"
                    />
                    <p className="text-[11px] text-muted-foreground leading-relaxed">
                      É o contrato da resposta: os campos que o agente é obrigado a devolver. Mexa
                      só se precisar de algo além de <code>mensagem_de_resposta</code> e{' '}
                      <code>rota</code>. A lista de <code>etapa</code> é trocada pelas etapas do
                      funil ao salvar e em toda execução — não adianta editar aqui.
                    </p>
                  </div>
                )}
              </div>

              <Separator />

              <label className="flex items-center gap-3 cursor-pointer">
                <Switch
                  checked={rascunho.active}
                  onCheckedChange={(v) => editar({ active: v })}
                />
                <span className="text-xs">
                  Agente ativo
                  <span className="block text-[11px] text-muted-foreground">
                    Desligado, o passo para aqui em vez de responder.
                  </span>
                </span>
              </label>

              {!criando && agente && (
                <>
                  <Separator />
                  {confirmandoExclusao ? (
                    <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 space-y-2">
                      <p className="text-[11px] leading-relaxed">
                        Excluir <strong>{agente.name}</strong> não tem volta. Este passo fica sem
                        agente e para de responder até você escolher outro — e o mesmo vale pra
                        qualquer outro fluxo que use este agente.
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="destructive"
                          className="h-7 text-xs"
                          disabled={excluir.isPending}
                          onClick={() => excluir.mutate(agente.id)}
                        >
                          {excluir.isPending && (
                            <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                          )}
                          Excluir mesmo assim
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 text-xs"
                          onClick={() => setConfirmandoExclusao(false)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8 text-xs text-destructive hover:text-destructive"
                      onClick={() => setConfirmandoExclusao(true)}
                    >
                      <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Excluir agente
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          <p className="text-[11px] text-muted-foreground sm:self-center text-left">
            {editando
              ? `Depois de salvar, o bloco fica com ${ROTAS_FIXAS.length + rotas.length} saídas.`
              : 'Nada selecionado.'}
          </p>
          <div className="flex gap-2 sm:justify-end">
            <Button variant="outline" onClick={fechar}>
              Fechar
            </Button>
            <Button onClick={enviar} disabled={!editando || salvar.isPending}>
              {salvar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {criando ? 'Criar agente' : 'Salvar'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
