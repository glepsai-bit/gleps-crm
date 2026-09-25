/**
 * PainelBase — a base de conhecimento sem sair do canvas.
 *
 * Abre pelo ícone de ampliar do bloco "Base de conhecimento". Traz o que antes
 * só existia na aba Conhecimento: escolher/criar/excluir base, o texto do
 * negócio, os documentos com status de indexação, reindexar/excluir e testar a
 * busca.
 *
 * A ordem do painel é a ordem das perguntas do usuário: primeiro QUAL base
 * este bloco usa (escolher, criar, excluir — as três com texto, não só ícone),
 * depois o que a IA sabe sobre o negócio, depois COMO colocar material dentro
 * (arquivo, texto colado ou página do site — lado a lado), aí a lista do que
 * já está lá e, por fim, o teste da busca.
 *
 * Tudo é INLINE dentro deste diálogo — nada de diálogo sobre diálogo. O painel
 * já é uma camada por cima do canvas; empilhar mais uma tira o usuário do
 * contexto que ele veio evitar. Por isso até a confirmação de exclusão é um
 * bloco que abre no lugar, e não um AlertDialog. Pelo mesmo motivo o erro de
 * envio (PDF escaneado, página sem texto, arquivo grande) fica ao lado do
 * botão que o causou, e não só num toast que some.
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
  ClipboardPaste,
  Clock,
  FileText,
  Globe,
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

/** Os três jeitos de colocar material na base. */
type Caminho = 'arquivo' | 'texto' | 'url';

/** Vão inteiros ao servidor (multipart) — é lá que o texto é extraído. */
const EXTENSOES_UPLOAD = ['pdf', 'docx'];
/** Planilha: o navegador converte pra CSV antes de enviar. */
const EXTENSOES_PLANILHA = ['xlsx'];
/** O navegador lê como texto puro o que já é texto puro. */
const EXTENSOES_TEXTO = ['txt', 'md', 'csv', 'json'];
const ACEITA_ARQUIVO = '.pdf,.docx,.xlsx,.csv,.txt,.md,.json';

/** Mesmo teto do servidor para o que sobe inteiro (PDF e Word). */
const LIMITE_UPLOAD_MB = 15;
/**
 * Teto do que é aberto na aba. `file.text()` e a leitura da planilha carregam
 * tudo na memória do navegador: um .json de dezenas de MB congela a página
 * antes de qualquer erro aparecer.
 */
const LIMITE_NAVEGADOR_MB = 2;
const MB = 1024 * 1024;

const extensaoDe = (nome: string) => nome.split('.').pop()?.toLowerCase() ?? '';
const semExtensao = (nome: string) => nome.replace(/\.[^.]+$/, '');
const tamanhoLegivel = (bytes: number) =>
  bytes < MB ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / MB).toFixed(1)} MB`;

/**
 * O apiClient rejeita com um objeto { message, status } (não é Error) e o
 * fetch do upload faz igual; o `throw new Error` local também cai aqui.
 * Extrai o texto de qualquer um dos três sem cair no "[object Object]".
 */
function mensagemDeErro(e: unknown, fallback: string): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message?: unknown }).message;
    if (typeof m === 'string' && m.trim()) return m;
  }
  return fallback;
}

/**
 * Cada aba vira um bloco CSV; com mais de uma, cada bloco leva um título —
 * é a linha de prosa que separa uma tabela da outra no fatiador do servidor.
 * A lib entra por import dinâmico: é grande e só quem sobe planilha paga por ela.
 */
async function planilhaParaCsv(file: File): Promise<string> {
  const XLSX = await import('xlsx');
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const blocos = workbook.SheetNames.map((nome) => ({
    nome,
    csv: XLSX.utils.sheet_to_csv(workbook.Sheets[nome]).trim(),
  })).filter((b) => b.csv);
  if (blocos.length <= 1) return blocos[0]?.csv ?? '';
  return blocos.map((b) => `# ${b.nome}\n${b.csv}`).join('\n\n');
}

/**
 * O texto tem cara de CONTEÚDO em vez de nome de assunto?
 *
 * Nasceu de um caso real: uma base chamada "Botox:500, Harmonização:300,".
 * Nome de base não é indexado — aquele preço nunca chegou ao agente, e nada na
 * tela avisou. Heurística de propósito frouxa: só avisa, nunca impede.
 */
/** "tabela-de-precos.pdf" → "Tabela de precos". O nome sai do arquivo. */
function nomeDeArquivo(nome: string): string {
  const semExt = nome.replace(/\.[^.]+$/, '');
  const limpo = semExt.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  return limpo ? limpo.charAt(0).toUpperCase() + limpo.slice(1) : 'Base de conhecimento';
}

function pareceConteudo(nome: string): boolean {
  const t = nome.trim();
  if (t.length < 25) return false;
  // "Botox:500" — item seguido de valor. É a forma que apareceu de verdade;
  // procurar número-separador-número não pegaria.
  const itemComValor = /[A-Za-zÀ-ÿ]\s*[:=]\s*\d/.test(t) || /R\$\s*\d/.test(t);
  const listaDeItens = (t.match(/[;,]/g) ?? []).length >= 2;
  return t.length > 70 || t.includes('\n') || (itemComValor && listaDeItens) || itemComValor;
}

/**
 * Os quatro assuntos que toda base de atendimento acaba tendo.
 *
 * Substitui a tela vazia. Base em branco é o momento em que a pessoa trava — e
 * foi onde alguém, numa conta real, acabou digitando a tabela de preços no
 * campo do NOME da base. Aqui ela escolhe um assunto e já cai no formulário
 * certo, com o título preenchido.
 *
 * A divisão não é estética: no teste em produção, documento de assunto único
 * deu nota 0,58–0,65 nas buscas, e o que misturava cancelamento, atraso,
 * pagamento e horário deu 0,35. Separar por assunto é o que a busca premia.
 */
const MODELO: { titulo: string; exemplo: string; caminho: Caminho }[] = [
  { titulo: 'Preços', exemplo: 'a tabela, em PDF ou planilha', caminho: 'arquivo' },
  { titulo: 'Políticas', exemplo: 'cancelamento, atraso, pagamento', caminho: 'arquivo' },
  { titulo: 'Dúvidas frequentes', exemplo: 'o que perguntam todo dia', caminho: 'texto' },
  { titulo: 'Sobre os serviços', exemplo: 'o que é cada um, quanto dura', caminho: 'arquivo' },
];

function ModeloDeBase({
  onEscolher,
}: {
  onEscolher: (m: { titulo: string; caminho: Caminho }) => void;
}) {
  return (
    <div className="py-4 space-y-3">
      <p className="text-xs text-muted-foreground leading-relaxed">
        Base vazia. O agente só tem o texto do negócio acima — e é pouco. Comece por um destes:
      </p>
      <div className="grid grid-cols-2 gap-2">
        {MODELO.map((m) => (
          <button
            key={m.titulo}
            type="button"
            onClick={() => onEscolher(m)}
            className="rounded-md border border-dashed p-2.5 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
          >
            <span className="block text-xs font-medium">{m.titulo}</span>
            <span className="block text-[11px] text-muted-foreground leading-snug">
              {m.exemplo}
            </span>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground leading-relaxed">
        Um assunto por documento. Misturar tudo num arquivo só faz o agente achar o trecho
        errado — medimos: separado, a busca acerta quase o dobro.
      </p>
    </div>
  );
}

export function PainelBase({ baseId, onEscolher, onFechar }: Props) {
  const queryClient = useQueryClient();

  const [criandoBase, setCriandoBase] = useState(false);
  const [novaBase, setNovaBase] = useState({ name: '', description: '' });
  // Rascunho do "sobre o negócio": separado da query para o refetch do poll não
  // sobrescrever o texto no meio da digitação.
  const [contexto, setContexto] = useState<string | null>(null);

  const [caminho, setCaminho] = useState<Caminho | null>(null);
  const [docForm, setDocForm] = useState({ title: '', content: '' });
  const [arquivo, setArquivo] = useState<File | null>(null);
  const [tituloArquivo, setTituloArquivo] = useState('');
  const [urlForm, setUrlForm] = useState({ url: '', title: '' });
  /** Erro do caminho aberto — fica ao lado do botão que o causou. */
  const [erroMaterial, setErroMaterial] = useState<string | null>(null);
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

  /** Zera os três caminhos de material de uma vez. */
  const limparMaterial = () => {
    setCaminho(null);
    setDocForm({ title: '', content: '' });
    setArquivo(null);
    setTituloArquivo('');
    setUrlForm({ url: '', title: '' });
    setErroMaterial(null);
  };

  // Troca de base zera tudo que era da base anterior — resultado de busca e
  // rascunho de material pertencem a uma base só. Quem dispara a troca pergunta
  // antes (`trocarBase`); aqui é só a limpeza.
  useEffect(() => {
    setContexto(null);
    setTrechos(null);
    setBusca('');
    setCaminho(null);
    setDocForm({ title: '', content: '' });
    setArquivo(null);
    setTituloArquivo('');
    setUrlForm({ url: '', title: '' });
    setErroMaterial(null);
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
  const rascunhoMaterial =
    !!docForm.title.trim() ||
    !!docForm.content.trim() ||
    !!arquivo ||
    !!tituloArquivo.trim() ||
    !!urlForm.url.trim() ||
    !!urlForm.title.trim();
  /** O que pertence à base da vez — trocar de base zera os dois. */
  const rascunhoDaBase = contextoAlterado || rascunhoMaterial;
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
      limparMaterial();
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

  /** O que os três caminhos fazem igual depois que o documento entra. */
  const documentoEntrou = () => {
    invalidarBases();
    invalidarDocs(baseId);
    setErroMaterial(null);
    toast.success('Documento enviado', {
      description: 'A indexação roda em segundo plano — o status atualiza sozinho.',
    });
  };

  const enviarArquivoMutation = useMutation({
    mutationFn: async () => {
      const file = arquivo!;
      const ext = extensaoDe(file.name);
      const titulo = tituloArquivo.trim() || semExtensao(file.name);
      if (EXTENSOES_UPLOAD.includes(ext)) {
        return aiService.uploadDoc(baseId!, file, tituloArquivo.trim() || undefined);
      }
      const content = EXTENSOES_PLANILHA.includes(ext)
        ? await planilhaParaCsv(file)
        : await file.text();
      if (!content.trim()) {
        throw new Error(
          EXTENSOES_PLANILHA.includes(ext)
            ? 'A planilha está vazia — não há nada pra indexar.'
            : 'O arquivo está vazio — não há nada pra indexar.'
        );
      }
      // Sem isto todo documento entra como digitado e o nome do arquivo de
      // origem se perde — é por ele que se descobre de onde veio o material.
      return aiService.createDoc(baseId!, {
        title: titulo,
        content,
        sourceType: 'file',
        sourceRef: file.name,
      });
    },
    onSuccess: () => {
      // O caminho continua aberto: quem sobe um arquivo costuma subir o próximo.
      setArquivo(null);
      setTituloArquivo('');
      documentoEntrou();
    },
    onError: (e: unknown) => setErroMaterial(mensagemDeErro(e, 'Não deu pra enviar o arquivo')),
  });

  /**
   * Cria a base A PARTIR do arquivo, num gesto só.
   *
   * O formulário pedia primeiro um NOME — uma abstração — para alguém que
   * chegou com um arquivo na mão. Numa conta real a pessoa fez o que fazia
   * sentido pra ela e colou a tabela de preços no campo do nome; nome de base
   * não é indexado, então aquilo nunca chegou ao agente.
   *
   * Aqui o material vem primeiro e o nome sai do arquivo. A pessoa confirma
   * depois, se quiser.
   */
  const criarComArquivoMutation = useMutation({
    mutationFn: async (file: File) => {
      const base = await aiService.createBase({
        name: nomeDeArquivo(file.name),
        description: null,
      });
      try {
        await aiService.uploadDoc(base.id, file, nomeDeArquivo(file.name));
      } catch (err) {
        // A base fica: o material é que falhou (PDF escaneado, por exemplo). A
        // pessoa tenta outro arquivo sem recomeçar do zero.
        //
        // Toast além do aviso na seção: neste instante o painel está trocando
        // para a base recém-criada, e o aviso de material viveria numa seção
        // que ainda vai montar. Sem o toast, o erro passaria em branco.
        const msg = mensagemDeErro(err, 'A base foi criada, mas o arquivo não entrou');
        setErroMaterial(msg);
        toast.error(msg);
      }
      return base;
    },
    onSuccess: (base) => {
      invalidarBases();
      setCriandoBase(false);
      setNovaBase({ name: '', description: '' });
      onEscolher(base.id);
      toast.success('Base criada com o material dentro.');
    },
    onError: (e: unknown) => toast.error(mensagemDeErro(e, 'Não deu pra criar a base')),
  });

  const criarDocMutation = useMutation({
    mutationFn: () =>
      aiService.createDoc(baseId!, {
        title: docForm.title.trim(),
        content: docForm.content,
        sourceType: 'text',
        sourceRef: null,
      }),
    onSuccess: () => {
      setDocForm({ title: '', content: '' });
      documentoEntrou();
    },
    onError: (e: unknown) => setErroMaterial(mensagemDeErro(e, 'Não deu pra enviar o texto')),
  });

  const importarUrlMutation = useMutation({
    mutationFn: () => {
      const digitada = urlForm.url.trim();
      // "site.com/precos" é o que a maioria digita; o servidor exige o esquema.
      const url = /^https?:\/\//i.test(digitada) ? digitada : `https://${digitada}`;
      return aiService.createDocFromUrl(baseId!, url, urlForm.title.trim() || undefined);
    },
    onSuccess: () => {
      setUrlForm({ url: '', title: '' });
      documentoEntrou();
    },
    onError: (e: unknown) => setErroMaterial(mensagemDeErro(e, 'Não deu pra importar a página')),
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

  /** Barra o que não serve ANTES de sair da máquina: formato e tamanho. */
  const escolherArquivo = (file: File) => {
    const ext = extensaoDe(file.name);
    const sobeInteiro = EXTENSOES_UPLOAD.includes(ext);
    const aceito =
      sobeInteiro || EXTENSOES_PLANILHA.includes(ext) || EXTENSOES_TEXTO.includes(ext);
    if (!aceito) {
      setArquivo(null);
      setErroMaterial(
        `Formato não aceito (.${ext || '?'}). Envie PDF, Word (.docx), planilha (.xlsx), .csv, .txt, .md ou .json.`
      );
      return;
    }
    const limiteMb = sobeInteiro ? LIMITE_UPLOAD_MB : LIMITE_NAVEGADOR_MB;
    if (file.size > limiteMb * MB) {
      setArquivo(null);
      setErroMaterial(
        `Arquivo grande demais — ${tamanhoLegivel(file.size)}, o limite é ${limiteMb} MB. ` +
          (sobeInteiro
            ? 'Divida o material em partes por assunto — a busca também acerta mais assim.'
            : 'Acima disso a aba trava só para abrir o conteúdo. Quebre em arquivos menores por assunto.')
      );
      return;
    }
    setErroMaterial(null);
    setArquivo(file);
  };

  const abrirCaminho = (novo: Caminho) => {
    setErroMaterial(null);
    setCaminho((atual) => (atual === novo ? null : novo));
  };

  const semEmbeddings = statusQuery.data && !statusQuery.data.knowledgeBaseReady;
  const listaQuebrou = basesQuery.isError;
  // "Sumiu" só vale contra uma lista que CHEGOU. Com a lista quebrada ela vem
  // vazia por falha, e acusar sumiço faz o usuário criar uma base duplicada —
  // desligando o bloco da base real, que continua lá.
  const baseSumiu = !!baseId && !base && !basesQuery.isLoading && !listaQuebrou;

  const CAMINHOS: { id: Caminho; label: string; icon: typeof Upload; dica: string }[] = [
    { id: 'arquivo', label: 'Enviar arquivo', icon: Upload, dica: 'PDF, Word, planilha, texto' },
    { id: 'texto', label: 'Colar texto', icon: ClipboardPaste, dica: 'Digite ou cole aqui' },
    { id: 'url', label: 'Página do site', icon: Globe, dica: 'Importa o texto de uma URL' },
  ];

  const erroInline = erroMaterial && (
    <p role="alert" className="text-xs text-destructive leading-relaxed break-words">
      {erroMaterial}
    </p>
  );

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

          {/* ---------- 1. Qual base este bloco usa ---------- */}
          <div className="space-y-2">
            <div>
              <span className="text-sm font-medium">Qual base este bloco usa</span>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Escolha uma base já criada, crie uma nova ou exclua a que está ligada aqui.
              </p>
            </div>
            {basesQuery.isLoading ? (
              <Skeleton className="h-9 w-full" />
            ) : (
              <div className="flex flex-wrap gap-2">
                <Select
                  value={base?.id ?? undefined}
                  onValueChange={trocarBase}
                  disabled={listaQuebrou}
                >
                  <SelectTrigger
                    className="h-9 min-w-[200px] flex-1"
                    aria-label="Escolher base existente"
                  >
                    <SelectValue
                      placeholder={
                        listaQuebrou
                          ? 'Não consegui carregar as bases'
                          : basesQuery.data?.length
                            ? 'Escolher existente'
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
                  variant={criandoBase ? 'secondary' : 'outline'}
                  className="h-9 shrink-0"
                  disabled={listaQuebrou}
                  aria-pressed={criandoBase}
                  onClick={() => setCriandoBase((v) => !v)}
                >
                  {criandoBase ? (
                    <>
                      <X className="w-4 h-4 mr-1.5" /> Cancelar nova base
                    </>
                  ) : (
                    <>
                      <Plus className="w-4 h-4 mr-1.5" /> Criar nova base
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  className="h-9 shrink-0 text-destructive hover:text-destructive"
                  aria-label={base ? `Excluir a base ${base.name}` : 'Excluir esta base'}
                  title={base ? 'Excluir esta base' : 'Escolha uma base para poder excluí-la'}
                  onClick={() => setConfirmandoBase(true)}
                  disabled={!base || excluirBaseMutation.isPending}
                >
                  <Trash2 className="w-4 h-4 mr-1.5" /> Excluir esta
                </Button>
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
                {/*
                  A explicação vem ANTES dos campos. Depois é tarde: numa conta
                  real alguém criou a base com o nome
                  "Botox:500, Harmonização:300," — colou a tabela de preços no
                  campo do nome. Nome de base não é indexado, então aquele
                  conteúdo nunca chegou ao agente, e nada avisou.
                */}
                {/*
                  O ARQUIVO VEM PRIMEIRO. A pessoa chega com um material na mão;
                  pedir um nome antes é pedir uma abstração, e foi assim que
                  alguém acabou colando a tabela de preços no campo do nome.
                */}
                <div className="rounded-md border border-dashed p-3 text-center space-y-1.5">
                  <p className="text-xs font-medium">Já tem o material?</p>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Envie o arquivo e a base nasce pronta, com o nome tirado dele.
                  </p>
                  <input
                    id="pb-arquivo-novo"
                    type="file"
                    className="hidden"
                    accept={ACEITA_ARQUIVO}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      e.target.value = '';
                      if (f) criarComArquivoMutation.mutate(f);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={criarComArquivoMutation.isPending}
                    onClick={() => document.getElementById('pb-arquivo-novo')?.click()}
                  >
                    {criarComArquivoMutation.isPending ? (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    ) : (
                      <Upload className="w-3.5 h-3.5 mr-1.5" />
                    )}
                    Escolher arquivo
                  </Button>
                </div>

                <p className="text-[11px] text-muted-foreground text-center">
                  ou crie vazia e adicione o material depois
                </p>

                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  O nome é só o <strong>assunto</strong>. O conteúdo — tabela de preços,
                  regulamento, FAQ — entra em Material, e é só ele que o agente consulta.
                </p>
                <div className="space-y-1.5">
                  <Label htmlFor="pb-nome" className="text-xs">
                    Nome do assunto
                  </Label>
                  <Input
                    id="pb-nome"
                    className="h-8 bg-background"
                    maxLength={120}
                    value={novaBase.name}
                    onChange={(e) => setNovaBase({ ...novaBase, name: e.target.value })}
                    placeholder="Produto e preços"
                  />
                  {pareceConteudo(novaBase.name) && (
                    <p className="text-[11px] rounded-md border border-amber-500/60 bg-amber-500/10 p-2 leading-relaxed">
                      Isso parece o <strong>conteúdo</strong>, não o nome. O nome é curto, tipo
                      “Produto e preços”. A tabela em si entra em <strong>Material</strong> depois
                      que a base existir — e é de lá que o agente responde.
                    </p>
                  )}
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

              {/* ---------- 2. Sobre o negócio ---------- */}
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

              {/* ---------- 3. Adicionar material ---------- */}
              <div className="space-y-2">
                <div>
                  <span className="text-sm font-medium">Adicionar material</span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed">
                    Três jeitos de colocar conhecimento na base. Tudo vira trechos pesquisáveis —
                    o agente consulta só o que a pergunta do lead pede.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {CAMINHOS.map((c) => {
                    const Icone = c.icon;
                    const ativo = caminho === c.id;
                    return (
                      <Button
                        key={c.id}
                        type="button"
                        variant={ativo ? 'secondary' : 'outline'}
                        aria-pressed={ativo}
                        className={`h-auto py-2.5 flex-col items-start gap-0.5 text-left ${
                          ativo ? 'ring-1 ring-primary/40' : ''
                        }`}
                        onClick={() => abrirCaminho(c.id)}
                      >
                        <span className="flex items-center gap-1.5 text-sm font-medium">
                          <Icone className="w-4 h-4" /> {c.label}
                        </span>
                        <span className="text-[11px] text-muted-foreground font-normal">
                          {c.dica}
                        </span>
                      </Button>
                    );
                  })}
                </div>

                {caminho === 'arquivo' && (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-arquivo" className="text-xs">
                        Arquivo
                      </Label>
                      <Input
                        id="pb-doc-arquivo"
                        ref={arquivoRef}
                        type="file"
                        accept={ACEITA_ARQUIVO}
                        className="h-8 bg-background text-xs"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) escolherArquivo(file);
                          // Zera o input: sem isto, escolher o MESMO arquivo de
                          // novo (depois de corrigi-lo) não dispara o onChange.
                          if (arquivoRef.current) arquivoRef.current.value = '';
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        <strong>PDF e Word (.docx)</strong> até {LIMITE_UPLOAD_MB} MB — o texto é
                        extraído no servidor. <strong>Planilha (.xlsx)</strong> vira CSV aqui no
                        navegador. <strong>.csv, .txt, .md e .json</strong> até {LIMITE_NAVEGADOR_MB}{' '}
                        MB. PDF escaneado (só imagem) não é lido.
                      </p>
                    </div>

                    {arquivo && (
                      <>
                        <div className="flex items-center gap-2 text-xs">
                          <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                          <span className="font-medium truncate">{arquivo.name}</span>
                          <span className="text-muted-foreground shrink-0">
                            · {tamanhoLegivel(arquivo.size)}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 shrink-0"
                            aria-label="Remover arquivo escolhido"
                            onClick={() => {
                              setArquivo(null);
                              setErroMaterial(null);
                            }}
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        <div className="space-y-1.5">
                          <Label htmlFor="pb-doc-arquivo-titulo" className="text-xs">
                            Título (opcional)
                          </Label>
                          <Input
                            id="pb-doc-arquivo-titulo"
                            className="h-8 bg-background"
                            value={tituloArquivo}
                            onChange={(e) => setTituloArquivo(e.target.value)}
                            placeholder={semExtensao(arquivo.name)}
                          />
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Button
                        size="sm"
                        onClick={() => enviarArquivoMutation.mutate()}
                        disabled={!arquivo || enviarArquivoMutation.isPending}
                      >
                        {enviarArquivoMutation.isPending && (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        )}
                        Enviar para indexação
                      </Button>
                      {erroInline}
                    </div>
                  </div>
                )}

                {caminho === 'texto' && (
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
                      <Label htmlFor="pb-doc-conteudo" className="text-xs">
                        Conteúdo
                      </Label>
                      <Textarea
                        id="pb-doc-conteudo"
                        value={docForm.content}
                        onChange={(e) => setDocForm({ ...docForm, content: e.target.value })}
                        className="min-h-[160px] font-mono text-xs bg-background"
                        placeholder="Cole aqui o material do negócio…"
                      />
                      <p className="text-[11px] text-muted-foreground">
                        {docForm.content.length.toLocaleString('pt-BR')} caracteres
                      </p>
                    </div>
                    <div className="space-y-2">
                      <Button
                        size="sm"
                        onClick={() => criarDocMutation.mutate()}
                        disabled={
                          !docForm.title.trim() ||
                          !docForm.content.trim() ||
                          criarDocMutation.isPending
                        }
                      >
                        {criarDocMutation.isPending && (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        )}
                        Enviar para indexação
                      </Button>
                      {erroInline}
                    </div>
                  </div>
                )}

                {caminho === 'url' && (
                  <div className="rounded-md border bg-muted/30 p-3 space-y-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-url" className="text-xs">
                        Endereço da página
                      </Label>
                      <Input
                        id="pb-doc-url"
                        type="url"
                        inputMode="url"
                        className="h-8 bg-background"
                        value={urlForm.url}
                        onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })}
                        placeholder="https://seusite.com.br/planos"
                        onKeyDown={(e) => {
                          if (
                            e.key === 'Enter' &&
                            urlForm.url.trim() &&
                            !importarUrlMutation.isPending
                          ) {
                            e.preventDefault();
                            importarUrlMutation.mutate();
                          }
                        }}
                      />
                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                        O servidor baixa a página e guarda só o texto legível — títulos,
                        parágrafos, listas e tabelas. Uma página por documento; página que exige
                        login não é lida.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="pb-doc-url-titulo" className="text-xs">
                        Título (opcional)
                      </Label>
                      <Input
                        id="pb-doc-url-titulo"
                        className="h-8 bg-background"
                        value={urlForm.title}
                        onChange={(e) => setUrlForm({ ...urlForm, title: e.target.value })}
                        placeholder="Sem título, usa o da página"
                      />
                    </div>
                    <div className="space-y-2">
                      <Button
                        size="sm"
                        onClick={() => importarUrlMutation.mutate()}
                        disabled={!urlForm.url.trim() || importarUrlMutation.isPending}
                      >
                        {importarUrlMutation.isPending && (
                          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        )}
                        Importar página
                      </Button>
                      {erroInline}
                    </div>
                  </div>
                )}
              </div>

              {/* ---------- 4. Testar a busca ---------- */}
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
            {/* ---------- 5. Documentos ---------- */}
              <div className="space-y-2">
                <span className="text-sm font-medium">
                  Documentos
                  <span className="text-muted-foreground font-normal">
                    {' '}
                    · {base.chunkCount} trechos indexados
                  </span>
                </span>

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
                  <ModeloDeBase onEscolher={(m) => { setCaminho(m.caminho); setDocForm({ title: m.titulo, content: '' }); setTituloArquivo(m.titulo); }} />
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
                            {doc.sourceType === 'url' ? (
                              <Globe className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            ) : (
                              <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                            )}
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
                            {doc.sourceRef && (
                              <span
                                className="text-[11px] text-muted-foreground truncate max-w-[220px]"
                                title={doc.sourceRef}
                              >
                                {doc.sourceRef}
                              </span>
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

              </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
