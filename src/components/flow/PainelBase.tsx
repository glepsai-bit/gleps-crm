/**
 * PainelBase — a base de conhecimento sem sair do canvas.
 *
 * Abre pelo ícone de ampliar do bloco "Base de conhecimento". Traz o que antes
 * só existia na aba Conhecimento: escolher/criar/excluir base, o texto do
 * negócio, os documentos com status de indexação, reindexar/excluir e testar a
 * busca.
 *
 * Tudo é INLINE dentro deste diálogo — nada de diálogo sobre diálogo. O painel
 * já é uma camada por cima do canvas; empilhar mais uma tira o usuário do
 * contexto que ele veio evitar. Por isso até a confirmação de exclusão é um
 * bloco que abre no lugar, e não um AlertDialog.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  aiService,
  type KnowledgeBase,
  type KnowledgeDoc,
  type KnowledgeDocStatus,
  type KnowledgeHit,
} from '@/services/ai.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { toast } from 'sonner';
import {
  AlertTriangle,
  BookOpen,
  Building2,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  X,
  XCircle,
} from 'lucide-react';

interface Props {
  baseId: string | null;
  onEscolher: (id: string) => void;
  onFechar: () => void;
}

const STATUS_META: Record<
  KnowledgeDocStatus,
  { label: string; icon: typeof Clock; className: string }
> = {
  pending: { label: 'Na fila', icon: Clock, className: 'text-muted-foreground' },
  indexing: { label: 'Indexando', icon: Loader2, className: 'text-blue-600' },
  ready: { label: 'Pronto', icon: CheckCircle2, className: 'text-emerald-600' },
  failed: { label: 'Falhou', icon: XCircle, className: 'text-destructive' },
};

/** O navegador só consegue ler como texto puro o que já é texto puro. */
const EXTENSOES_TEXTO = ['txt', 'md', 'csv', 'json'];
const ACEITA_ARQUIVO = '.txt,.md,.csv,.json,text/plain,text/markdown,text/csv,application/json';

/**
 * Teto do arquivo lido no navegador. `file.text()` carrega tudo na memória da
 * aba e o textarea ainda precisa renderizar o resultado: um .json de dezenas de
 * MB congela a página antes de qualquer erro aparecer.
 */
const LIMITE_ARQUIVO_MB = 2;
const LIMITE_ARQUIVO_BYTES = LIMITE_ARQUIVO_MB * 1024 * 1024;

export function PainelBase({ baseId, onEscolher, onFechar }: Props) {
  const queryClient = useQueryClient();

  const [criandoBase, setCriandoBase] = useState(false);
  const [novaBase, setNovaBase] = useState({ name: '', description: '' });
  // Rascunho do "sobre o negócio": separado da query para o refetch do poll não
  // sobrescrever o texto no meio da digitação.
  const [contexto, setContexto] = useState<string | null>(null);

  const [docAberto, setDocAberto] = useState(false);
  const [docForm, setDocForm] = useState({ title: '', content: '' });
  /** Nome do arquivo de onde o conteúdo veio — vira o `sourceRef` do documento. */
  const [origemArquivo, setOrigemArquivo] = useState<string | null>(null);
  const [confirmandoExclusao, setConfirmandoExclusao] = useState<string | null>(null);
  const [confirmandoBase, setConfirmandoBase] = useState(false);
  const arquivoRef = useRef<HTMLInputElement>(null);

  const [busca, setBusca] = useState('');
  const [trechos, setTrechos] = useState<KnowledgeHit[] | null>(null);

  const statusQuery = useQuery({ queryKey: ['ai', 'status'], queryFn: aiService.getStatus });
  const basesQuery = useQuery({ queryKey: ['ai', 'bases'], queryFn: aiService.listBases });
  // Mesma chave do canvas e do PainelAgente: quase sempre já está em cache, e é
  // ela que diz quem fica sem base se esta for excluída.
  const agentesQuery = useQuery({ queryKey: ['ai-agents'], queryFn: aiService.listAgents });

  const base: KnowledgeBase | null = basesQuery.data?.find((b) => b.id === baseId) ?? null;
  const agentesUsando = (agentesQuery.data ?? []).filter((a) => a.knowledgeBaseId === baseId);

  const docsQuery = useQuery({
    queryKey: ['ai', 'docs', baseId],
    queryFn: () => aiService.listDocs(baseId!),
    enabled: !!baseId,
    // O worker de indexação varre a fila a cada 30s. Sem poll, o documento fica
    // "Na fila" na tela até um F5 — e o usuário conclui que quebrou. Metade do
    // período do worker mantém o atraso na tela abaixo de um ciclo sem bater na
    // API seis vezes por varredura. Para assim que nada mais está em fila.
    refetchInterval: (query) => {
      const docs = query.state.data as KnowledgeDoc[] | undefined;
      const naFila = docs?.some((d) => d.status === 'pending' || d.status === 'indexing');
      return naFila ? 15000 : false;
    },
  });

  // Troca de base zera tudo que era da base anterior — resultado de busca e
  // rascunho de texto pertencem a uma base só. Quem dispara a troca pergunta
  // antes (`trocarBase`); aqui é só a limpeza.
  useEffect(() => {
    setContexto(null);
    setTrechos(null);
    setBusca('');
    setDocAberto(false);
    setDocForm({ title: '', content: '' });
    setOrigemArquivo(null);
    setConfirmandoExclusao(null);
    setConfirmandoBase(false);
  }, [baseId]);

  // Duas chaves de propósito: as páginas de IA leem ['ai','bases'] e o canvas
  // lê ['ai-bases']. Invalidar só uma deixa o seletor do bloco sem a base
  // recém-criada.
  const invalidarBases = () => {
    queryClient.invalidateQueries({ queryKey: ['ai', 'bases'] });
    queryClient.invalidateQueries({ queryKey: ['ai-bases'] });
  };

  /** Recebe o id explícito: a base da vez nem sempre é a que está no estado. */
  const invalidarDocs = (id: string | null) => {
    if (id) queryClient.invalidateQueries({ queryKey: ['ai', 'docs', id] });
  };

  const contextoAlterado = contexto !== null && contexto !== (base?.businessContext ?? '');
  /** O que pertence à base da vez — trocar de base zera os dois. */
  const rascunhoDaBase = contextoAlterado || !!docForm.title.trim() || !!docForm.content.trim();
  // O formulário da base nova sobrevive à troca de base, mas morre junto com o
  // painel: conta para fechar, não para trocar.
  const rascunhoNovaBase =
    criandoBase && (!!novaBase.name.trim() || !!novaBase.description.trim());
  const sujo = rascunhoDaBase || rascunhoNovaBase;

  const avisar = (pendente: boolean) =>
    !pendente ||
    window.confirm('Você escreveu algo aqui e não salvou. Sair agora descarta o que digitou.');

  // Radix fecha no Esc, no X e no clique fora: sem esta guarda o texto que o
  // usuário acabou de colar some sem aviso nenhum.
  const podeFechar = () => avisar(sujo);
  /** Trocar (ou criar) base descarta só o que era da base anterior. */
  const podeTrocarDeBase = () => avisar(rascunhoDaBase);

  const trocarBase = (id: string) => {
    if (id === baseId || !podeTrocarDeBase()) return;
    onEscolher(id);
  };

  const fechar = () => {
    if (podeFechar()) onFechar();
  };

  const criarBaseMutation = useMutation({
    mutationFn: () =>
      aiService.createBase({
        name: novaBase.name.trim(),
        description: novaBase.description.trim() || null,
      }),
    onSuccess: (criada) => {
      // Só as bases: a base nova nasce vazia e ['ai','docs', <id antigo>] não
      // tem nada a ver com ela.
      invalidarBases();
      setCriandoBase(false);
      setNovaBase({ name: '', description: '' });
      onEscolher(criada.id);
      toast.success('Base criada e já ligada neste bloco.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra criar a base'),
  });

  const excluirBaseMutation = useMutation({
    mutationFn: (id: string) => aiService.deleteBase(id),
    onSuccess: () => {
      setConfirmandoBase(false);
      setContexto(null);
      setDocAberto(false);
      setDocForm({ title: '', content: '' });
      setOrigemArquivo(null);
      setTrechos(null);
      setBusca('');
      invalidarBases();
      // Quem apontava pra ela fica sem base (SetNull no banco); sem invalidar,
      // o painel do agente segue exibindo o vínculo que não existe mais.
      queryClient.invalidateQueries({ queryKey: ['ai-agents'] });
      queryClient.invalidateQueries({ queryKey: ['ai', 'agents'] });
      toast.success('Base excluída.', {
        description: 'Escolha outra base ou crie uma nova para este bloco.',
      });
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra excluir a base'),
  });

  const salvarContextoMutation = useMutation({
    mutationFn: () =>
      aiService.updateBase(baseId!, { businessContext: contexto?.trim() || null }),
    onSuccess: (atualizada) => {
      // A resposta já é a base salva. Sem escrever no cache, o textarea cai no
      // valor antigo até o refetch chegar — e continua revertido se o refetch
      // falhar, parecendo que não salvou.
      const trocar = (atual: KnowledgeBase[] | undefined) =>
        atual?.map((b) => (b.id === atualizada.id ? atualizada : b));
      queryClient.setQueryData<KnowledgeBase[]>(['ai', 'bases'], trocar);
      queryClient.setQueryData<KnowledgeBase[]>(['ai-bases'], trocar);
      setContexto(null);
      invalidarBases();
      toast.success('Salvo — entra em toda resposta dos agentes ligados nesta base.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra salvar'),
  });

  const criarDocMutation = useMutation({
    mutationFn: () =>
      aiService.createDoc(baseId!, {
        title: docForm.title.trim(),
        content: docForm.content,
        // Sem isto todo documento entra como digitado e o nome do arquivo de
        // origem se perde — é por ele que se descobre de onde veio o material.
        sourceType: origemArquivo ? 'file' : 'text',
        sourceRef: origemArquivo,
      }),
    onSuccess: () => {
      invalidarBases();
      invalidarDocs(baseId);
      setDocAberto(false);
      setDocForm({ title: '', content: '' });
      setOrigemArquivo(null);
      toast.success('Documento enviado', {
        description: 'A indexação roda em segundo plano — o status atualiza sozinho.',
      });
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra enviar o documento'),
  });

  const reindexarMutation = useMutation({
    mutationFn: (id: string) => aiService.reindexDoc(id),
    onSuccess: () => {
      invalidarBases();
      invalidarDocs(baseId);
      toast.success('Documento recolocado na fila.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra reindexar'),
  });

  const excluirDocMutation = useMutation({
    mutationFn: (id: string) => aiService.deleteDoc(id),
    onSuccess: () => {
      setConfirmandoExclusao(null);
      invalidarBases();
      invalidarDocs(baseId);
      toast.success('Documento excluído.');
    },
    onError: (e: Error) => toast.error(e.message || 'Não deu pra excluir'),
  });

  const buscarMutation = useMutation({
    mutationFn: () => aiService.searchBase(baseId!, busca.trim()),
    onSuccess: (hits) => setTrechos(hits),
    onError: (e: Error) => toast.error(e.message || 'A busca falhou'),
  });

  // Nunca rejeita: é chamada com `void` no onChange do input, e uma promise
  // solta quebraria em silêncio, sem toast nenhum.
  const lerArquivo = async (file: File) => {
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (!EXTENSOES_TEXTO.includes(ext)) {
      toast.error('Esse arquivo não serve aqui', {
        description:
          'PDF e Word são arquivos binários: o texto chega embaralhado e a IA aprende lixo. Abra o arquivo, copie o texto e cole no campo abaixo.',
      });
      return;
    }
    if (file.size > LIMITE_ARQUIVO_BYTES) {
      toast.error(
        `Arquivo grande demais — ${(file.size / 1024 / 1024).toFixed(1)} MB, o limite é ${LIMITE_ARQUIVO_MB} MB`,
        {
          description:
            'Acima disso a aba trava só para abrir o texto. Quebre o material em documentos menores por assunto — a busca também acerta mais assim.',
        }
      );
      return;
    }
    try {
      const content = await file.text();
      setDocForm((atual) => ({
        title: atual.title.trim() || file.name.replace(/\.[^.]+$/, ''),
        content,
      }));
      setOrigemArquivo(file.name);
    } catch {
      toast.error('Não deu pra ler o arquivo', {
        description:
          'Ele pode ter sido movido depois de escolhido, ou não ser texto de verdade. Abra o arquivo, copie o conteúdo e cole no campo abaixo.',
      });
    }
  };

  const semEmbeddings = statusQuery.data && !statusQuery.data.knowledgeBaseReady;
  const listaQuebrou = basesQuery.isError;
  // "Sumiu" só vale contra uma lista que CHEGOU. Com a lista quebrada ela vem
  // vazia por falha, e acusar sumiço faz o usuário criar uma base duplicada —
  // desligando o bloco da base real, que continua lá.
  const baseSumiu = !!baseId && !base && !basesQuery.isLoading && !listaQuebrou;

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fechar()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="w-5 h-5" /> Base de conhecimento
            {sujo && (
              <Badge variant="outline" className="text-[10px] font-normal">
                não salvo
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            O que a IA pode afirmar sobre o seu negócio. Monte aqui mesmo — não precisa sair do
            fluxo.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1 -mr-1">
          {semEmbeddings && (
            <div className="flex gap-2 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-xs text-destructive leading-relaxed">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <p>
                Falta uma <strong>chave OpenAI</strong> — é ela que transforma o documento em
                trechos pesquisáveis. Cadastre em <strong>Administração → Integrações</strong>;
                sem ela tudo fica parado em “Na fila”.
              </p>
            </div>
          )}

          {/* ---------- Escolher, criar ou excluir a base ---------- */}
          <div className="space-y-2">
            <Label className="text-xs">Base usada por este bloco</Label>
            {basesQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <div className="flex gap-2">
                <Select
                  value={base?.id ?? undefined}
                  onValueChange={trocarBase}
                  disabled={listaQuebrou}
                >
                  <SelectTrigger className="h-9">
                    <SelectValue
                      placeholder={
                        listaQuebrou
                          ? 'Não consegui carregar as bases'
                          : basesQuery.data?.length
                            ? 'Escolha a base'
                            : 'Nenhuma base criada ainda'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {basesQuery.data?.map((b) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name} · {b.docCount} doc(s)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  className="h-9 shrink-0"
                  disabled={listaQuebrou}
                  onClick={() => setCriandoBase((v) => !v)}
                >
                  {criandoBase ? (
                    <X className="w-4 h-4" />
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-1.5" /> Nova base
                    </>
                  )}
                </Button>
                {base && (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-destructive"
                    aria-label={`Excluir a base ${base.name}`}
                    title="Excluir esta base"
                    onClick={() => setConfirmandoBase(true)}
                    disabled={excluirBaseMutation.isPending}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
            )}

            {listaQuebrou && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs text-destructive leading-relaxed">
                  Não deu pra carregar as bases
                  {basesQuery.error instanceof Error && basesQuery.error.message
                    ? ` — ${basesQuery.error.message}`
                    : '.'}{' '}
                  A base deste bloco continua ligada; o seletor é que está vazio por falha. Não
                  crie uma base agora — sem a lista, você criaria uma duplicada e o bloco sairia
                  da base de verdade.
                </p>
                <Button size="sm" variant="outline" onClick={() => void basesQuery.refetch()}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Tentar de novo
                </Button>
              </div>
            )}

            {baseSumiu && (
              <p className="text-xs text-destructive">
                A base que estava neste bloco não existe mais. Escolha outra ou crie uma nova.
              </p>
            )}

            {confirmandoBase && base && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-2">
                <p className="text-xs leading-relaxed">
                  Excluir <strong>{base.name}</strong> apaga {base.docCount} documento(s) e os{' '}
                  {base.chunkCount} trechos já indexados. Não dá pra desfazer.
                </p>
                {agentesQuery.isLoading ? (
                  <p className="text-xs text-muted-foreground">
                    Conferindo quais agentes usam esta base…
                  </p>
                ) : agentesQuery.isError ? (
                  <p className="text-xs text-destructive leading-relaxed">
                    Não deu pra conferir quais agentes usam esta base — pode haver atendimento
                    dependendo dela.
                  </p>
                ) : (
                  agentesUsando.length > 0 && (
                    <p className="text-xs text-destructive leading-relaxed">
                      {agentesUsando.length === 1
                        ? 'Um agente consulta esta base'
                        : `${agentesUsando.length} agentes consultam esta base`}{' '}
                      ({agentesUsando.map((a) => a.name).join(', ')}). Eles continuam atendendo,
                      mas param de achar qualquer coisa até você ligar outra base.
                    </p>
                  )
                )}
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => excluirBaseMutation.mutate(base.id)}
                    // Enquanto a lista de agentes não chega, o aviso de quem
                    // depende da base ainda não pôde ser mostrado.
                    disabled={excluirBaseMutation.isPending || agentesQuery.isLoading}
                  >
                    {excluirBaseMutation.isPending && (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    )}
                    Excluir a base
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmandoBase(false)}>
                    Cancelar
                  </Button>
                </div>
              </div>
            )}

            {criandoBase && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="space-y-1.5">
                  <Label htmlFor="pb-nome" className="text-xs">
                    Nome
                  </Label>
                  <Input
                    id="pb-nome"
                    className="h-8 bg-background"
                    value={novaBase.name}
                    onChange={(e) => setNovaBase({ ...novaBase, name: e.target.value })}
                    placeholder="Produto e preços"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pb-desc" className="text-xs">
                    Descrição
                  </Label>
                  <Input
                    id="pb-desc"
                    className="h-8 bg-background"
                    value={novaBase.description}
                    onChange={(e) => setNovaBase({ ...novaBase, description: e.target.value })}
                    placeholder="O que esta base cobre"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Uma base por assunto — “Produto e preços”, “Objeções”, “Políticas”. Cada agente
                  aponta para uma; base enxuta responde melhor e custa menos.
                </p>
                <Button
                  size="sm"
                  // Criar troca a base do bloco: o rascunho em aberto é da base atual.
                  onClick={() => {
                    if (podeTrocarDeBase()) criarBaseMutation.mutate();
                  }}
                  disabled={listaQuebrou || !novaBase.name.trim() || criarBaseMutation.isPending}
                >
                  {criarBaseMutation.isPending && (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  )}
                  Criar e usar neste bloco
                </Button>
              </div>
            )}
          </div>

          {base && (
            <>
              <Separator />

              {/* ---------- Sobre o negócio ---------- */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <Building2 className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm font-medium">Sobre o negócio</span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Quem é a empresa, o que vende, o que nunca faz. Diferente dos documentos, isto
                  entra em <strong>toda</strong> resposta — o agente não precisa procurar. Curto:
                  cada palavra aqui é cobrada em cada mensagem.
                </p>
                <Textarea
                  value={contexto ?? base.businessContext ?? ''}
                  onChange={(e) => setContexto(e.target.value)}
                  placeholder="A Gleps vende CRM com WhatsApp para clínicas de estética. Ticket a partir de R$ 297/mês. Não atendemos pessoa física."
                  rows={3}
                  maxLength={8000}
                  className="text-sm resize-none bg-background"
                />
                {contexto !== null && (
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => salvarContextoMutation.mutate()}
                      disabled={salvarContextoMutation.isPending}
                    >
                      {salvarContextoMutation.isPending && (
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      )}
                      Salvar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setContexto(null)}>
                      Cancelar
                    </Button>
                  </div>
                )}
              </div>

              {/* ---------- Documentos ---------- */}
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">
                    Documentos
                    <span className="text-muted-foreground font-normal">
                      {' '}
                      · {base.chunkCount} trechos indexados
                    </span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setDocAberto((v) => !v)}>
                    {docAberto ? (
                      <>
                        <X className="w-4 h-4 mr-1.5" /> Fechar
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4 mr-1.5" /> Documento
                      </>
                    )}
                  </Button>
                </div>

                {docAberto && (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-titulo" className="text-xs">
                        Título
                      </Label>
                      <Input
                        id="pb-doc-titulo"
                        className="h-8 bg-background"
                        value={docForm.title}
                        onChange={(e) => setDocForm({ ...docForm, title: e.target.value })}
                        placeholder="Tabela de preços 2026"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-arquivo" className="text-xs flex items-center gap-1.5">
                        <Upload className="w-3.5 h-3.5" /> Arquivo de texto (opcional)
                      </Label>
                      <Input
                        id="pb-doc-arquivo"
                        ref={arquivoRef}
                        type="file"
                        accept={ACEITA_ARQUIVO}
                        className="h-8 bg-background text-xs"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void lerArquivo(file);
                          // Zera o input: sem isto, escolher o MESMO arquivo de
                          // novo (depois de corrigi-lo) não dispara o onChange.
                          if (arquivoRef.current) arquivoRef.current.value = '';
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Aceita <strong>.txt, .md, .csv e .json</strong> de até {LIMITE_ARQUIVO_MB}{' '}
                        MB. PDF e Word não — são arquivos binários e o texto sai embaralhado; abra,
                        copie e cole abaixo.
                      </p>
                    </div>

                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-conteudo" className="text-xs">
                        Conteúdo
                      </Label>
                      <Textarea
                        id="pb-doc-conteudo"
                        value={docForm.content}
                        onChange={(e) => {
                          const content = e.target.value;
                          setDocForm((atual) => ({ ...atual, content }));
                          // Esvaziou o campo: o que vier depois é texto digitado,
                          // não mais o arquivo que foi carregado antes.
                          if (!content.trim()) setOrigemArquivo(null);
                        }}
                        className="min-h-[160px] font-mono text-xs bg-background"
                        placeholder="Cole aqui o material do negócio…"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {docForm.content.length.toLocaleString('pt-BR')} caracteres
                        {origemArquivo && <> · carregado de {origemArquivo}</>}
                      </p>
                    </div>

                    <Button
                      size="sm"
                      onClick={() => criarDocMutation.mutate()}
                      disabled={
                        !docForm.title.trim() || !docForm.content.trim() || criarDocMutation.isPending
                      }
                    >
                      {criarDocMutation.isPending && (
                        <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      )}
                      Enviar para indexação
                    </Button>
                  </div>
                )}

                {docsQuery.isLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : docsQuery.isError ? (
                  <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-2">
                    <p className="text-xs text-destructive leading-relaxed">
                      Não deu pra carregar os documentos desta base
                      {docsQuery.error instanceof Error && docsQuery.error.message
                        ? ` — ${docsQuery.error.message}`
                        : '.'}{' '}
                      A base pode ter documentos: esta lista está vazia por falha, não por estar
                      sem material.
                    </p>
                    <Button size="sm" variant="outline" onClick={() => void docsQuery.refetch()}>
                      <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Tentar de novo
                    </Button>
                  </div>
                ) : docsQuery.data?.length === 0 ? (
                  <p className="text-xs text-muted-foreground text-center py-6 leading-relaxed">
                    Nenhum documento nesta base. Sem eles o agente só tem o texto do negócio
                    acima.
                  </p>
                ) : (
                  docsQuery.data?.map((doc) => {
                    const meta = STATUS_META[doc.status];
                    const Icone = meta.icon;
                    const confirmando = confirmandoExclusao === doc.id;
                    return (
                      <div
                        key={doc.id}
                        className="flex items-start justify-between gap-3 rounded-md border p-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            <span className="text-sm font-medium truncate">{doc.title}</span>
                          </div>
                          <div className="flex items-center gap-2 mt-1 flex-wrap">
                            <span
                              className={`inline-flex items-center gap-1 text-[11px] ${meta.className}`}
                            >
                              <Icone
                                className={`w-3 h-3 ${doc.status === 'indexing' ? 'animate-spin' : ''}`}
                              />
                              {meta.label}
                            </span>
                            {doc.status === 'ready' && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {doc.chunkCount} trechos
                              </Badge>
                            )}
                          </div>
                          {doc.summary && (
                            /* É esta linha que vai pro índice no prompt do agente:
                               quando o resumo automático erra, o agente busca errado.
                               Mostrar aqui é o que permite perceber. */
                            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
                              <span className="font-medium">Cobre:</span> {doc.summary}
                            </p>
                          )}
                          {doc.error && (
                            <p className="text-[11px] text-destructive mt-1 break-words">
                              {doc.error}
                            </p>
                          )}
                        </div>

                        {confirmando ? (
                          <div className="flex items-center gap-1 shrink-0">
                            <Button
                              size="sm"
                              variant="destructive"
                              className="h-7 text-xs"
                              onClick={() => excluirDocMutation.mutate(doc.id)}
                              disabled={excluirDocMutation.isPending}
                            >
                              Excluir
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => setConfirmandoExclusao(null)}
                            >
                              Cancelar
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-0.5 shrink-0">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`Reindexar ${doc.title}`}
                              title="Reindexar"
                              onClick={() => reindexarMutation.mutate(doc.id)}
                              disabled={reindexarMutation.isPending}
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              aria-label={`Excluir ${doc.title}`}
                              title="Excluir"
                              onClick={() => setConfirmandoExclusao(doc.id)}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              <Separator />

              {/* ---------- Testar a busca ---------- */}
              <div className="space-y-2">
                <span className="text-sm font-medium flex items-center gap-2">
                  <Search className="w-4 h-4" /> Testar a busca
                </span>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Pergunte como um lead perguntaria e veja o que o agente receberia. Sai mais
                  barato descobrir aqui do que no meio do atendimento.
                </p>
                <div className="flex gap-2">
                  <Input
                    className="h-9"
                    value={busca}
                    onChange={(e) => setBusca(e.target.value)}
                    placeholder="Quanto custa o plano mais barato?"
                    onKeyDown={(e) => {
                      // Mesma trava do botão: segurar Enter dispararia uma busca
                      // por repetição de tecla, todas concorrentes.
                      if (e.key === 'Enter' && busca.trim() && !buscarMutation.isPending) {
                        e.preventDefault();
                        buscarMutation.mutate();
                      }
                    }}
                  />
                  <Button
                    className="h-9 shrink-0"
                    aria-label="Buscar na base"
                    onClick={() => buscarMutation.mutate()}
                    disabled={!busca.trim() || buscarMutation.isPending}
                  >
                    {buscarMutation.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Search className="w-4 h-4" />
                    )}
                  </Button>
                </div>

                {trechos && (
                  <div className="space-y-2">
                    {trechos.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        Nenhum trecho passou do corte de relevância — nesse caso o agente
                        responderia sem a base. Vale subir um documento que cubra o assunto.
                      </p>
                    ) : (
                      trechos.map((t) => (
                        <div key={t.chunkId} className="rounded-md border p-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-xs font-medium truncate">
                              {t.docTitle || 'sem título'}
                            </span>
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                              {(t.score * 100).toFixed(0)}%
                            </Badge>
                          </div>
                          <p className="text-[11px] text-muted-foreground mt-1 line-clamp-3 leading-snug">
                            {t.content}
                          </p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
