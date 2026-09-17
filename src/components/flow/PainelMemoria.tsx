/**
 * T-037 — o que este agente lembra, declarado pelo admin.
 *
 * O problema que esta tela resolve: a ferramenta `lembrar` recebia o nome do
 * campo como texto livre. O mesmo fato virava `faturamento` numa conversa,
 * `faturamento_mensal` na outra e `receita_mensal` na terceira — memória que
 * ninguém consegue ler de volta, nem outro agente, nem um relatório, nem o
 * próprio agente na conversa seguinte.
 *
 * Declarando os campos, o backend transforma `campo` em lista fechada e usa a
 * descrição de cada um como a instrução que o modelo lê para decidir o que vai
 * ali. Por isso a descrição é o campo importante desta tela, e não um enfeite.
 *
 * COMPATIBILIDADE: lista vazia é o estado de toda a produção de hoje — sem
 * campo declarado o agente continua com campo livre, exatamente como antes. A
 * tela diz isso em voz alta para ninguém achar que precisa preencher.
 *
 * Como o PainelBase: tudo INLINE neste diálogo. Ele já é uma camada por cima
 * do canvas; empilhar outro diálogo tira o usuário do contexto que ele veio
 * evitar.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Brain, Loader2, Plus, Sparkles, Trash2 } from 'lucide-react';
import { aiService, type AiAgent, type AiAgentInput } from '@/services/ai.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
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

interface Props {
  agentId: string;
  onFechar: () => void;
}

type EscopoDeMemoria = 'memoria' | 'sessao';

/** O que viaja para o backend — mesma forma de `CampoDeMemoria` do service. */
interface CampoDeMemoria {
  chave: string;
  descricao: string;
  escopo: EscopoDeMemoria;
}

/** A linha na tela. O `id` existe porque a chave muda enquanto se digita (e
 *  pode até estar repetida) — não serve como chave de lista do React. */
interface Linha extends CampoDeMemoria {
  id: string;
}

interface Problema {
  chave?: string;
  descricao?: string;
}

/** `memoryFields` ainda não está no tipo público do service — a coluna é nova. */
type AgenteComMemoria = AiAgent & { memoryFields?: unknown };
type EntradaComMemoria = AiAgentInput & { memoryFields: CampoDeMemoria[] };

// Mesmas regras de `backend/src/services/ai/memoria-declarada.ts`. Repetidas
// aqui de propósito: o backend recusa, mas quem está escrevendo o campo merece
// saber do erro antes de clicar em salvar.
const CHAVE_VALIDA = /^[a-z][a-z0-9_]{1,48}$/;
const MAX_DESCRICAO = 400;
const MAX_CAMPOS = 40;

const ESCOPOS: { valor: EscopoDeMemoria; rotulo: string; ajuda: string }[] = [
  {
    valor: 'memoria',
    rotulo: 'Sobre a pessoa — vale para as próximas conversas',
    ajuda: 'Fica com o contato. Se ele sumir e voltar em março, o agente ainda sabe.',
  },
  {
    valor: 'sessao',
    rotulo: 'Só desta conversa — some quando ela encerra',
    ajuda: 'Serve para o que vale agora: o que ficou combinado, onde o atendimento parou.',
  },
];

/** Um atendimento comercial quase sempre quer estes. Ninguém é obrigado. */
const SUGESTOES: CampoDeMemoria[] = [
  {
    chave: 'nome',
    descricao:
      'Como a pessoa quer ser chamada. Preencha quando ela mesma disser o nome, não deduza do perfil.',
    escopo: 'memoria',
  },
  {
    chave: 'o_que_procura',
    descricao:
      'O que a pessoa veio resolver, nas palavras dela: o produto, o serviço ou o problema que a trouxe aqui.',
    escopo: 'memoria',
  },
  {
    chave: 'combinado',
    descricao:
      'O que ficou acertado nesta conversa: horário marcado, valor citado, qual é o próximo passo e de quem é a vez.',
    escopo: 'sessao',
  },
  {
    chave: 'objecao',
    descricao:
      'O que está travando a decisão: preço, prazo, precisa falar com outra pessoa, já usa um concorrente.',
    escopo: 'memoria',
  },
  {
    chave: 'como_chegou',
    descricao: 'Por onde a pessoa chegou até aqui: indicação, anúncio, busca no Google, já é cliente.',
    escopo: 'memoria',
  },
];

/** Os três que abrem qualquer atendimento — o botão de um clique da tela vazia. */
const SUGESTOES_INICIAIS = SUGESTOES.slice(0, 3);

let sequencia = 0;
const novoId = () => `campo-${++sequencia}`;

/**
 * Leitura do que está gravado.
 *
 * Deliberadamente FROUXA: aceita qualquer registro com chave em texto, mesmo
 * fora do padrão. Descartar o torto aqui faria o campo sumir da tela e, no
 * salvar seguinte, sumir do banco sem ninguém ter pedido. Quem aponta o
 * problema é a validação do formulário, que o deixa visível e corrigível.
 */
function lerCampos(bruto: unknown): Linha[] {
  if (!Array.isArray(bruto)) return [];
  return bruto.slice(0, MAX_CAMPOS).flatMap((item): Linha[] => {
    if (!item || typeof item !== 'object') return [];
    const registro = item as Record<string, unknown>;
    if (typeof registro.chave !== 'string') return [];
    return [
      {
        id: novoId(),
        chave: registro.chave,
        descricao: typeof registro.descricao === 'string' ? registro.descricao : '',
        escopo: registro.escopo === 'sessao' ? 'sessao' : 'memoria',
      },
    ];
  });
}

function validar(linhas: Linha[]): Record<string, Problema> {
  const vistos = new Set<string>();
  const problemas: Record<string, Problema> = {};

  for (const linha of linhas) {
    const chave = linha.chave.trim();
    const descricao = linha.descricao.trim();
    const problema: Problema = {};

    if (!chave) {
      problema.chave = 'Informe a chave.';
    } else if (chave.startsWith('_')) {
      // Explícito, e não um "chave inválida" genérico: o "_" é reservado ao
      // controle interno do motor, e o admin merece saber por que foi recusado.
      problema.chave = 'A chave não pode começar com "_" — esse começo é reservado ao sistema.';
    } else if (/\s/.test(chave)) {
      problema.chave = 'A chave não pode ter espaço — use "_" no lugar (ex: faturamento_mensal).';
    } else if (!CHAVE_VALIDA.test(chave)) {
      problema.chave =
        'Use letras minúsculas sem acento, números e "_", começando por letra e com pelo menos 2 caracteres (ex: faturamento_mensal).';
    } else if (vistos.has(chave)) {
      problema.chave = 'Já existe um campo com esta chave.';
    } else {
      vistos.add(chave);
    }

    if (!descricao) {
      problema.descricao = 'Descreva o que guardar aqui — é este texto que o agente lê para decidir.';
    } else if (descricao.length > MAX_DESCRICAO) {
      problema.descricao = `Máximo de ${MAX_DESCRICAO} caracteres — este tem ${descricao.length}.`;
    }

    if (problema.chave || problema.descricao) problemas[linha.id] = problema;
  }

  return problemas;
}

export function PainelMemoria({ agentId, onFechar }: Props) {
  const qc = useQueryClient();

  // Mesma chave do canvas: a lista já está em cache quando o painel abre.
  const agentesQuery = useQuery({ queryKey: ['ai-agents'], queryFn: aiService.listAgents });
  const agente = (agentesQuery.data ?? []).find((a) => a.id === agentId) ?? null;

  const [linhas, setLinhas] = useState<Linha[]>([]);
  const [sujo, setSujo] = useState(false);
  const [tocadas, setTocadas] = useState<Record<string, boolean>>({});
  const [tentouSalvar, setTentouSalvar] = useState(false);

  // Hidrata uma vez por agente. Depender do objeto inteiro faria o refetch da
  // lista (a cada foco na janela) apagar o que está sendo digitado.
  const carregado = useRef<string | null>(null);
  useEffect(() => {
    if (!agente || carregado.current === agente.id) return;
    carregado.current = agente.id;
    setLinhas(lerCampos((agente as AgenteComMemoria).memoryFields));
    setSujo(false);
    setTocadas({});
    setTentouSalvar(false);
  }, [agente]);

  const problemas = useMemo(() => validar(linhas), [linhas]);
  const totalProblemas = Object.keys(problemas).length;
  const chavesEmUso = useMemo(
    () => new Set(linhas.map((l) => l.chave.trim())),
    [linhas]
  );

  const editar = (id: string, mudanca: Partial<CampoDeMemoria>) => {
    setLinhas((atual) => atual.map((l) => (l.id === id ? { ...l, ...mudanca } : l)));
    setTocadas((t) => ({ ...t, [id]: true }));
    setSujo(true);
  };

  const remover = (id: string) => {
    setLinhas((atual) => atual.filter((l) => l.id !== id));
    setSujo(true);
  };

  const acrescentar = (novos: CampoDeMemoria[]) => {
    const disponiveis = MAX_CAMPOS - linhas.length;
    if (disponiveis <= 0) {
      toast.error(`Limite de ${MAX_CAMPOS} campos por agente.`);
      return;
    }
    setLinhas((atual) => [
      ...atual,
      ...novos.slice(0, disponiveis).map((c) => ({ ...c, id: novoId() })),
    ]);
    setSujo(true);
  };

  const salvar = useMutation({
    mutationFn: () => {
      const payload: EntradaComMemoria = {
        memoryFields: linhas.map((l) => ({
          chave: l.chave.trim(),
          descricao: l.descricao.trim(),
          escopo: l.escopo,
        })),
      };
      return aiService.updateAgent(agentId, payload);
    },
    onSuccess: () => {
      // Duas chaves de propósito: o canvas lê 'ai-agents' e a página de agentes
      // lê ['ai','agents']. Invalidar só uma deixa a outra tela desatualizada.
      qc.invalidateQueries({ queryKey: ['ai-agents'] });
      qc.invalidateQueries({ queryKey: ['ai', 'agents'] });
      setSujo(false);
      setTentouSalvar(false);
      toast.success(
        linhas.length === 0 ? 'Campos removidos' : 'Memória do agente salva',
        linhas.length === 0
          ? { description: 'Sem campos declarados, o agente volta a lembrar por conta própria.' }
          : { description: 'A partir da próxima conversa o agente só grava nestes campos.' }
      );
    },
    onError: (e: Error) => toast.error(e.message || 'Não foi possível salvar os campos'),
  });

  const enviar = () => {
    setTentouSalvar(true);
    if (totalProblemas > 0) {
      toast.error(
        totalProblemas === 1
          ? 'Um campo está incompleto — corrija antes de salvar.'
          : `${totalProblemas} campos estão incompletos — corrija antes de salvar.`
      );
      return;
    }
    salvar.mutate();
  };

  const podeSair = () =>
    !sujo ||
    window.confirm('Você mexeu nos campos de memória e não salvou. Sair agora descarta a mudança.');

  const fechar = () => {
    if (podeSair()) onFechar();
  };

  const carregando = agentesQuery.isLoading;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fechar()}>
      <DialogContent className="sm:max-w-3xl sm:h-[88vh] sm:max-h-[88vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Brain className="w-5 h-5" /> O que este agente lembra
            {sujo && (
              <Badge variant="outline" className="text-[10px] font-normal">
                não salvo
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {agente
              ? `Os campos que ${agente.name} preenche enquanto conversa. A descrição de cada um é o que ele lê para decidir o que guardar ali.`
              : 'Os campos que o agente preenche enquanto conversa.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1">
          {carregando ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : !agente ? (
            <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
              Não encontrei este agente. Feche o painel e escolha outro no bloco.
            </div>
          ) : (
            <>
              {linhas.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center space-y-3">
                  <Brain className="w-9 h-9 opacity-30 mx-auto" />
                  <div className="space-y-1">
                    <p className="font-medium text-sm">Nenhum campo declarado</p>
                    <p className="text-[11px] text-muted-foreground leading-relaxed max-w-md mx-auto">
                      Hoje o agente lembra o que quiser, com o nome que ele mesmo inventar — e é por
                      isso que o mesmo fato aparece com três nomes diferentes. Declarando os campos,
                      ele passa a gravar só nestes, sempre com a mesma chave.
                    </p>
                  </div>
                  <Button size="sm" onClick={() => acrescentar(SUGESTOES_INICIAIS)}>
                    <Sparkles className="w-4 h-4 mr-1.5" /> Começar com nome, o que procura e
                    combinado
                  </Button>
                </div>
              )}

              {linhas.map((linha, indice) => {
                const problema = problemas[linha.id];
                const mostrarErro = tentouSalvar || tocadas[linha.id];
                const chaveLimpa = linha.chave.trim();
                const prefixo = linha.escopo === 'sessao' ? 'sessao' : 'memoria';
                return (
                  <div key={linha.id} className="rounded-lg border p-3 space-y-2.5">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0 space-y-1.5">
                        <Label htmlFor={`pm-chave-${linha.id}`} className="text-xs">
                          Nome da chave
                        </Label>
                        <Input
                          id={`pm-chave-${linha.id}`}
                          className="h-9 font-mono text-xs"
                          spellCheck={false}
                          autoFocus={indice === linhas.length - 1 && !chaveLimpa}
                          value={linha.chave}
                          placeholder="faturamento_mensal"
                          onChange={(e) => editar(linha.id, { chave: e.target.value })}
                        />
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="mt-6 shrink-0 text-muted-foreground hover:text-destructive"
                        aria-label={`Remover ${chaveLimpa || 'campo'}`}
                        onClick={() => remover(linha.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                    {mostrarErro && problema?.chave ? (
                      <p className="text-[11px] text-destructive leading-relaxed">
                        {problema.chave}
                      </p>
                    ) : (
                      chaveLimpa && (
                        <p className="text-[11px] text-muted-foreground">
                          Nos textos do fluxo este campo é{' '}
                          <code>{`{{${prefixo}.${chaveLimpa}}}`}</code>.
                        </p>
                      )
                    )}

                    <div className="space-y-1.5">
                      <Label htmlFor={`pm-desc-${linha.id}`} className="text-xs">
                        O que guardar aqui
                      </Label>
                      <Textarea
                        id={`pm-desc-${linha.id}`}
                        rows={2}
                        className="text-xs leading-relaxed"
                        value={linha.descricao}
                        placeholder="Quanto a empresa fatura por mês, como a pessoa falou — faixa ou valor."
                        onChange={(e) => editar(linha.id, { descricao: e.target.value })}
                      />
                      {mostrarErro && problema?.descricao ? (
                        <p className="text-[11px] text-destructive leading-relaxed">
                          {problema.descricao}
                        </p>
                      ) : (
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          É esta frase que o agente lê para saber quando preencher. Vaga demais, o
                          campo fica vazio — ou vem preenchido com a coisa errada.
                        </p>
                      )}
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor={`pm-escopo-${linha.id}`} className="text-xs">
                        Vale até quando
                      </Label>
                      <Select
                        value={linha.escopo}
                        onValueChange={(v) => editar(linha.id, { escopo: v as EscopoDeMemoria })}
                      >
                        <SelectTrigger id={`pm-escopo-${linha.id}`} className="h-9">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ESCOPOS.map((e) => (
                            <SelectItem key={e.valor} value={e.valor}>
                              {e.rotulo}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        {ESCOPOS.find((e) => e.valor === linha.escopo)?.ajuda}
                      </p>
                    </div>
                  </div>
                );
              })}

              <Button
                type="button"
                variant="outline"
                className="w-full"
                disabled={linhas.length >= MAX_CAMPOS}
                onClick={() =>
                  acrescentar([{ chave: '', descricao: '', escopo: 'memoria' }])
                }
              >
                <Plus className="w-4 h-4 mr-1.5" /> Adicionar campo
              </Button>

              <Separator />

              <div className="space-y-2">
                <Label className="text-xs flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5" /> Campos comuns de atendimento
                </Label>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Um clique inclui o campo já descrito. Depois é só ajustar o texto para o seu
                  negócio — a descrição genérica funciona, a sua funciona melhor.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {SUGESTOES.map((s) => {
                    const jaTem = chavesEmUso.has(s.chave);
                    return (
                      <Button
                        key={s.chave}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 text-xs font-mono"
                        disabled={jaTem || linhas.length >= MAX_CAMPOS}
                        title={jaTem ? 'Este campo já está na lista' : s.descricao}
                        onClick={() => acrescentar([s])}
                      >
                        <Plus className="w-3.5 h-3.5 mr-1" />
                        {s.chave}
                      </Button>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter className="sm:justify-between">
          <p className="text-[11px] text-muted-foreground sm:self-center text-left">
            {totalProblemas > 0
              ? `${totalProblemas} ${totalProblemas === 1 ? 'campo precisa' : 'campos precisam'} de correção.`
              : linhas.length === 0
                ? 'Sem campos declarados, o agente segue lembrando por conta própria — como hoje.'
                : `${linhas.length} de ${MAX_CAMPOS} campos. Só estes o agente consegue gravar.`}
          </p>
          <div className="flex gap-2 sm:justify-end">
            <Button variant="outline" onClick={fechar}>
              Fechar
            </Button>
            <Button onClick={enviar} disabled={!agente || salvar.isPending}>
              {salvar.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Salvar
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
