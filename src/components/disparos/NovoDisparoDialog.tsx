import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, FileText, Image as ImageIcon, Loader2, Mic, Sparkles, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Segmentado } from '@/components/dashboard/Segmentado';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { tagsBackendService } from '@/services/tags.backend.service';
import { createTemplate } from '@/services/whatsapp-templates.backend.service';
import {
  disparosService,
  type AnexoDisparo,
  type AtendeRespostas,
  type DisparoResumo,
  type ListaDisparo,
  type TipoAnexo,
} from '@/services/disparos.backend.service';
import {
  CHIP_STATUS_NUMERO,
  FUSO_PADRAO,
  fusoDaConta,
  VARIAVEIS,
  dataNoFuso,
  descreverCapacidade,
  diasNecessarios,
  estimarTermino,
  formatarDia,
  formatarDataHora,
  formatarHora,
  formatarTamanho,
  formatarTelefone,
  renderizarTexto,
  rotuloChipNumero,
} from './disparosFormat';
import { cn } from '@/lib/utils';

type TipoLista = 'publico' | 'leads' | 'numeros';

const MAX_VARIACOES = 3;
const LIMITE_ANEXO: Record<TipoAnexo, { bytes: number; accept: string; rotulo: string }> = {
  imagem: { bytes: 2 * 1024 * 1024, accept: 'image/jpeg,image/png,image/webp', rotulo: 'a imagem (2 MB)' },
  pdf: { bytes: 5 * 1024 * 1024, accept: 'application/pdf', rotulo: 'o PDF (5 MB)' },
  audio: { bytes: 2 * 1024 * 1024, accept: 'audio/ogg,audio/mpeg,audio/mp4,audio/x-m4a,.ogg,.mp3,.m4a', rotulo: 'o áudio (2 MB)' },
};

interface Audiencia {
  id: string;
  name: string;
  total_leads?: number;
  /** O backend Express devolve camelCase; o Supabase, snake_case. */
  totalLeads?: number;
}

interface NovoDisparoDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Público já escolhido (vindo da Extração via ?publico=). */
  publicoInicial?: string | null;
  /** Texto de uma mensagem salva ("Usar"). */
  textoInicial?: string | null;
  /** Disparo agendado que está sendo refeito: ao confirmar, o antigo é cancelado. */
  editando?: DisparoResumo | null;
}

function linhasDe(texto: string): string[] {
  return texto.split('\n').map((l) => l.trim()).filter(Boolean);
}

function useAtraso<T>(valor: T, ms: number): T {
  const [v, setV] = useState(valor);
  useEffect(() => {
    const t = setTimeout(() => setV(valor), ms);
    return () => clearTimeout(t);
  }, [valor, ms]);
  return v;
}

export function NovoDisparoDialog({ open, onOpenChange, publicoInicial, textoInicial, editando }: NovoDisparoDialogProps) {
  const { account } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const accountId = account?.id ?? '';
  const fuso = fusoDaConta(account);

  const [tipoLista, setTipoLista] = useState<TipoLista>('publico');
  const [audienceId, setAudienceId] = useState('');
  const [etapaTagId, setEtapaTagId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [colados, setColados] = useState('');

  const [texto, setTexto] = useState('');
  const [variantes, setVariantes] = useState<string[]>([]);
  const [opcoesIA, setOpcoesIA] = useState<string[]>([]);
  const [anexo, setAnexo] = useState<AnexoDisparo | null>(null);
  const [subindo, setSubindo] = useState(false);
  const [salvarMensagem, setSalvarMensagem] = useState(false);

  const [inboxIds, setInboxIds] = useState<string[]>([]);
  const [atende, setAtende] = useState<AtendeRespostas>('agente');
  const [quando, setQuando] = useState<'agora' | 'agendar'>('agora');
  const [agendarLocal, setAgendarLocal] = useState('');

  const textoRef = useRef<HTMLTextAreaElement>(null);
  const arquivoRef = useRef<HTMLInputElement>(null);
  const tipoAnexoPendente = useRef<TipoAnexo>('imagem');

  const { data: audiencias = [] } = useQuery({
    queryKey: ['disparos', 'publicos'],
    enabled: open,
    queryFn: async (): Promise<Audiencia[]> => {
      const res = await apiClient.get<Audiencia[] | { data: Audiencia[] }>(API_ENDPOINTS.PROSPECTING.AUDIENCES);
      const lista = Array.isArray(res) ? res : res?.data;
      return Array.isArray(lista) ? lista : [];
    },
  });
  const { data: etapas = [] } = useQuery({
    queryKey: ['disparos', 'etapas', accountId],
    enabled: open && !!accountId,
    queryFn: () => tagsBackendService.listStageTags(accountId),
  });
  const { data: todasTags = [] } = useQuery({
    queryKey: ['disparos', 'tags', accountId],
    enabled: open && !!accountId,
    queryFn: () => tagsBackendService.listAllTags(accountId),
  });
  const tagsComuns = useMemo(() => todasTags.filter((t) => t.type !== 'stage'), [todasTags]);
  const { data: numerosResp } = useQuery({
    queryKey: ['disparos', 'numeros'],
    enabled: open,
    queryFn: () => disparosService.numeros(),
  });
  const numeros = useMemo(() => numerosResp?.numeros ?? [], [numerosResp]);

  // Cada abertura começa do estado certo: do zero, de um público, de uma mensagem salva ou de um disparo a refazer.
  useEffect(() => {
    if (!open) return;
    setOpcoesIA([]);
    setSalvarMensagem(false);
    setSubindo(false);
    if (editando) {
      setTipoLista(editando.lista.tipo);
      if (editando.lista.tipo === 'publico') setAudienceId(editando.lista.audienceId);
      if (editando.lista.tipo === 'leads') {
        setEtapaTagId(editando.lista.etapaTagId ?? '');
        setTagIds(editando.lista.tagIds ?? []);
      }
      if (editando.lista.tipo === 'numeros') setColados((editando.lista.linhas ?? []).join('\n'));
      setTexto(editando.texto);
      setVariantes(editando.variantes);
      setAnexo(editando.anexo);
      setInboxIds(editando.inboxIds);
      setAtende(editando.atendeRespostas);
      setQuando('agendar');
      setAgendarLocal('');
      return;
    }
    setTipoLista('publico');
    setAudienceId(publicoInicial ?? '');
    setEtapaTagId('');
    setTagIds([]);
    setColados('');
    setTexto(textoInicial ?? '');
    setVariantes([]);
    setAnexo(null);
    setInboxIds([]);
    setAtende('agente');
    setQuando('agora');
    setAgendarLocal('');
  }, [open, editando, publicoInicial, textoInicial]);

  // Pré-seleciona o número mais folgado assim que a lista chega.
  const recomendado = useMemo(() => {
    const aptos = numeros.filter((x) => x.conectado && (x.status === 'pronto' || x.status === 'aquecendo'));
    return [...aptos].sort((a, b) => b.restantesHoje - a.restantesHoje)[0]?.inboxId ?? null;
  }, [numeros]);
  useEffect(() => {
    // Forma funcional: o efeito de reset acima acabou de zerar a seleção e este
    // closure ainda enxerga a anterior (reabrir o diálogo ficava sem número).
    if (open && !editando && recomendado) setInboxIds((x) => (x.length === 0 ? [recomendado] : x));
    // só quando a lista de números chega; escolha do usuário não é sobrescrita
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, recomendado]);

  const lista: ListaDisparo | null = useMemo(() => {
    if (tipoLista === 'publico') return audienceId ? { tipo: 'publico', audienceId } : null;
    if (tipoLista === 'leads') {
      if (!etapaTagId && tagIds.length === 0) return null;
      return { tipo: 'leads', ...(etapaTagId ? { etapaTagId } : {}), ...(tagIds.length ? { tagIds } : {}) };
    }
    const linhas = linhasDe(colados);
    return linhas.length ? { tipo: 'numeros', quantidade: linhas.length, linhas } : null;
  }, [tipoLista, audienceId, etapaTagId, tagIds, colados]);

  const listaAtrasada = useAtraso(lista, 400);
  const { data: preview, isFetching: calculando } = useQuery({
    queryKey: ['disparos', 'preview', JSON.stringify(listaAtrasada)],
    enabled: open && !!listaAtrasada,
    queryFn: () => disparosService.previewLista(listaAtrasada!),
  });
  const vaoReceber = lista && preview ? preview.vaoReceber : 0;

  // ---- mensagem ----
  const inserirVariavel = (v: string) => {
    const el = textoRef.current;
    const ini = el?.selectionStart ?? texto.length;
    const fim = el?.selectionEnd ?? texto.length;
    setTexto(texto.slice(0, ini) + v + texto.slice(fim));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(ini + v.length, ini + v.length);
    });
  };

  const variarIA = useMutation({
    mutationFn: () => disparosService.variarComIA(texto),
    onSuccess: (opcoes) => setOpcoesIA(opcoes),
    onError: (e: Error) => toast({ title: 'Não foi possível variar com IA', description: e?.message, variant: 'destructive' }),
  });

  const adicionarOpcaoIA = (opcao: string) => {
    if (variantes.length >= MAX_VARIACOES) {
      toast({ title: `No máximo ${MAX_VARIACOES} variações`, description: 'Remova uma para usar outra.', variant: 'destructive' });
      return;
    }
    setVariantes((v) => [...v, opcao]);
  };

  const escolherArquivo = (tipo: TipoAnexo) => {
    tipoAnexoPendente.current = tipo;
    if (arquivoRef.current) {
      arquivoRef.current.accept = LIMITE_ANEXO[tipo].accept;
      arquivoRef.current.value = '';
      arquivoRef.current.click();
    }
  };

  const aoEscolherArquivo = async (arquivo: File | undefined) => {
    if (!arquivo) return;
    const tipo = tipoAnexoPendente.current;
    if (arquivo.size > LIMITE_ANEXO[tipo].bytes) {
      toast({ title: 'Arquivo grande demais', description: `Escolha ${LIMITE_ANEXO[tipo].rotulo} no máximo.`, variant: 'destructive' });
      return;
    }
    setSubindo(true);
    try {
      setAnexo(await disparosService.enviarAnexo(arquivo));
    } catch (e) {
      toast({ title: 'Anexo não enviado', description: (e as Error)?.message, variant: 'destructive' });
    } finally {
      setSubindo(false);
    }
  };

  // ---- envio ----
  const alternar = <T,>(lista: T[], item: T) => (lista.includes(item) ? lista.filter((x) => x !== item) : [...lista, item]);
  const selecionados = numeros.filter((x) => inboxIds.includes(x.inboxId));

  const agendadoPara = quando === 'agendar' && agendarLocal ? dataNoFuso(agendarLocal, fuso) : null;
  const inicio = agendadoPara ? new Date(agendadoPara) : new Date();
  const termino = vaoReceber > 0 && selecionados.length > 0 ? estimarTermino(inicio, vaoReceber, selecionados.length, fuso) : null;
  const mesmoDia = termino ? formatarDia(termino.toISOString(), fuso) === formatarDia(new Date().toISOString(), fuso) : true;

  const primeiroContato = useMemo(() => {
    if (tipoLista === 'numeros') {
      const l = linhasDe(colados)[0];
      if (l && l.includes(';')) return l.split(';')[0].trim() || 'Maria';
    }
    return 'Maria';
  }, [tipoLista, colados]);

  const nomeSugerido = () => {
    const base =
      tipoLista === 'publico' ? audiencias.find((a) => a.id === audienceId)?.name
        : tipoLista === 'leads' ? (etapas.find((e) => e.id === etapaTagId)?.name ?? 'Leads do CRM')
          : 'Números colados';
    return `${base ?? 'Disparo'} · ${formatarDataHora((agendadoPara ?? new Date().toISOString()), fuso)}`.slice(0, 120);
  };

  const criar = useMutation({
    mutationFn: async () => {
      const novo = await disparosService.criar({
        nome: nomeSugerido(),
        texto: texto.trim(),
        variantes: variantes.map((v) => v.trim()).filter(Boolean),
        anexo,
        lista: lista!,
        inboxIds,
        atendeRespostas: atende,
        ...(agendadoPara ? { agendadoPara } : {}),
      });
      // "Editar" = refazer: só cancela o antigo depois que o novo nasceu, para nunca perder a lista.
      if (editando) await disparosService.cancelar(editando.id);
      if (salvarMensagem) {
        const nome = texto.trim().split(/\s+/).slice(0, 4).join(' ');
        await createTemplate({ name: nome || 'Mensagem', content: texto.trim(), category: 'custom' }).catch(() => {
          toast({ title: 'O disparo saiu, mas a mensagem não foi salva', variant: 'destructive' });
        });
      }
      return novo;
    },
    onSuccess: () => {
      toast({ title: agendadoPara ? 'Disparo agendado' : 'Disparo iniciado' });
      qc.invalidateQueries({ queryKey: ['disparos'] });
      qc.invalidateQueries({ queryKey: ['whatsapp-templates'] });
      onOpenChange(false);
    },
    onError: (e: Error) => toast({ title: 'Não foi possível criar o disparo', description: e?.message, variant: 'destructive' }),
  });

  const textoOk = texto.trim().length > 0;
  const quandoOk = quando === 'agora' || (!!agendadoPara && new Date(agendadoPara).getTime() > Date.now());
  const pode = !!lista && vaoReceber > 0 && textoOk && inboxIds.length > 0 && quandoOk && !criar.isPending && !subindo;

  const rotuloBotao = quando === 'agendar' && agendadoPara
    ? `Agendar para ${formatarDataHora(agendadoPara, fuso).replace(' ', ' ')}`
    : `Disparar para ${vaoReceber} contatos`;

  const bolhaTexto = renderizarTexto(texto || 'Sua mensagem aparece aqui.', primeiroContato);
  const horaPrevia = formatarHora(inicio.toISOString(), fuso);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl max-h-[92vh] overflow-y-auto gap-5">
        <DialogHeader>
          <DialogTitle>{editando ? 'Editar disparo agendado' : 'Novo disparo'}</DialogTitle>
          <DialogDescription>Três perguntas: para quem, o quê, e por qual número.</DialogDescription>
        </DialogHeader>

        {/* 1. Para quem */}
        <section className="space-y-3" aria-label="Para quem">
          <Passo n={1} titulo="Para quem" />
          <Segmentado<TipoLista>
            rotuloGrupo="Origem da lista"
            valor={tipoLista}
            onChange={setTipoLista}
            opcoes={[
              { valor: 'publico', rotulo: 'Público salvo' },
              { valor: 'leads', rotulo: 'Leads do CRM' },
              { valor: 'numeros', rotulo: 'Colar números' },
            ]}
          />

          {tipoLista === 'publico' && (
            <div className="space-y-2">
              <Label htmlFor="disparo-publico">Público</Label>
              <Select value={audienceId} onValueChange={setAudienceId}>
                <SelectTrigger id="disparo-publico"><SelectValue placeholder="Escolha um público" /></SelectTrigger>
                <SelectContent>
                  {audiencias.map((a) => (
                    <SelectItem key={a.id} value={a.id}>{a.name} · {a.totalLeads ?? a.total_leads ?? 0} contatos</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {tipoLista === 'leads' && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="disparo-etapa">Etapa do Kanban</Label>
                <Select value={etapaTagId || '__todas__'} onValueChange={(v) => setEtapaTagId(v === '__todas__' ? '' : v)}>
                  <SelectTrigger id="disparo-etapa"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__todas__">Qualquer etapa</SelectItem>
                    {etapas.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {tagsComuns.length > 0 && (
                <div className="space-y-2">
                  <Label>Tags (opcional)</Label>
                  <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
                    {tagsComuns.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        aria-pressed={tagIds.includes(t.id)}
                        onClick={() => setTagIds((x) => alternar(x, t.id))}
                        className={cn(
                          'h-7 rounded-full border px-3 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          tagIds.includes(t.id) ? 'border-primary bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted',
                        )}
                      >
                        {t.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {tipoLista === 'numeros' && (
            <div className="space-y-2">
              <Label htmlFor="disparo-colados">Números</Label>
              <Textarea
                id="disparo-colados"
                rows={5}
                value={colados}
                onChange={(e) => setColados(e.target.value)}
                placeholder={'Um por linha: Nome;telefone ou só o telefone\nMaria Souza;(34) 98811-9078\n34988119078'}
              />
            </div>
          )}

          {lista && (
            <div className="flex flex-wrap items-center gap-2" aria-live="polite">
              {calculando && !preview ? (
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Conferindo a lista…</span>
              ) : preview ? (
                <>
                  <span className="inline-flex h-[22px] items-center rounded-full bg-success/15 px-2.5 text-[11.5px] font-semibold text-success">
                    <b className="tabular-nums mr-1">{preview.vaoReceber}</b> vão receber
                  </span>
                  <ChipFato n={preview.optout} texto="pediram para sair · pulados" />
                  <ChipFato n={preview.duplicados} texto="repetidos · removidos" />
                  <ChipFato n={preview.invalidos} texto="sem telefone válido" />
                </>
              ) : null}
            </div>
          )}
        </section>

        {/* 2. Mensagem */}
        <section className="space-y-3 border-t pt-5" aria-label="Mensagem">
          <Passo n={2} titulo="Mensagem" />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2">
              <Label htmlFor="disparo-texto">Texto</Label>
              <Textarea
                id="disparo-texto"
                ref={textoRef}
                rows={6}
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
                placeholder="Oi {{nome}}, tudo bem? …"
              />
              <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                Inserir:
                {VARIAVEIS.map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => inserirVariavel(v)}
                    className="h-6 rounded-md bg-primary/10 px-2 font-mono text-xs font-semibold text-primary hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {v}
                  </button>
                ))}
              </div>

              {variantes.map((v, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Variação {i + 1}</span>
                    <button type="button" className="hover:text-foreground" onClick={() => setVariantes((x) => x.filter((_, j) => j !== i))}>Remover</button>
                  </div>
                  <Textarea rows={3} aria-label={`Variação ${i + 1}`} value={v} onChange={(e) => setVariantes((x) => x.map((y, j) => (j === i ? e.target.value : y)))} />
                </div>
              ))}

              <div className="flex flex-wrap items-center gap-2">
                {variantes.length < MAX_VARIACOES && (
                  <button type="button" className="text-xs text-primary hover:underline" onClick={() => setVariantes((x) => [...x, ''])}>
                    + Adicionar uma variação
                  </button>
                )}
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={!textoOk || variarIA.isPending} onClick={() => variarIA.mutate()}>
                  {variarIA.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
                  Variar com IA
                </Button>
              </div>
              {opcoesIA.length > 0 && (
                <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2" aria-label="Opções da IA">
                  <div className="text-xs text-muted-foreground">Clique para usar como variação:</div>
                  {opcoesIA.map((o, i) => (
                    <button key={i} type="button" onClick={() => adicionarOpcaoIA(o)} className="block w-full rounded-md border bg-card px-2.5 py-1.5 text-left text-xs hover:border-primary">
                      {o}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Anexo (opcional):
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={subindo} onClick={() => escolherArquivo('imagem')}><ImageIcon className="h-3.5 w-3.5" />Imagem</Button>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={subindo} onClick={() => escolherArquivo('pdf')}><FileText className="h-3.5 w-3.5" />PDF</Button>
                <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" disabled={subindo} onClick={() => escolherArquivo('audio')}><Mic className="h-3.5 w-3.5" />Áudio</Button>
                <input ref={arquivoRef} type="file" className="hidden" data-testid="disparo-arquivo" onChange={(e) => aoEscolherArquivo(e.target.files?.[0])} />
              </div>
              {subindo && <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" />Enviando anexo…</div>}
              {anexo && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-muted px-2.5 py-2 text-[12.5px]">
                  <span className="min-w-0 truncate">
                    {anexo.nome} <span className="text-muted-foreground">· {formatarTamanho(anexo.tamanho)} · vai como 2ª mensagem</span>
                  </span>
                  <button type="button" aria-label="Remover anexo" className="text-muted-foreground hover:text-foreground" onClick={() => setAnexo(null)}><X className="h-4 w-4" /></button>
                </div>
              )}
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Checkbox checked={salvarMensagem} onCheckedChange={(v) => setSalvarMensagem(v === true)} aria-label="Salvar esta mensagem para reutilizar" />
                Salvar esta mensagem para reutilizar
              </label>
            </div>

            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-sm font-medium">Como {primeiroContato} vai receber</span>
              {/* Bolha no estilo WhatsApp, só com tokens do tema para valer em claro e escuro. */}
              <div className="flex min-h-[220px] flex-1 flex-col justify-end gap-1.5 rounded-xl border bg-muted/60 p-3.5" data-testid="previa-whatsapp">
                <div className="max-w-[88%] whitespace-pre-wrap rounded-[10px_10px_10px_2px] bg-success/20 px-2.5 py-2 text-[13px] leading-snug text-foreground">
                  {bolhaTexto}
                  <span className="mt-1 block text-right text-[10.5px] tabular-nums text-muted-foreground">{horaPrevia}</span>
                </div>
                {anexo && (
                  <div className="max-w-[70%] rounded-[10px_10px_10px_2px] bg-success/20 p-1">
                    <div className="flex h-20 items-center justify-center rounded-[7px] bg-muted px-2 text-center text-[11.5px] text-muted-foreground">{anexo.nome}</div>
                    <span className="mx-1.5 mb-0.5 mt-1 block text-right text-[10.5px] tabular-nums text-muted-foreground">{horaPrevia}</span>
                  </div>
                )}
              </div>
              {variantes.length > 0 && <p className="text-xs text-muted-foreground">O sistema alterna entre o texto e as {variantes.length} variações.</p>}
            </div>
          </div>
        </section>

        {/* 3. Envio */}
        <section className="space-y-3 border-t pt-5" aria-label="Envio">
          <Passo n={3} titulo="Envio" />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Por qual número <span className="font-normal text-muted-foreground">(pode marcar mais de um)</span></legend>
            {numeros.length === 0 && <p className="text-sm text-muted-foreground">Nenhum número de WhatsApp conectado.</p>}
            {numeros.map((num) => {
              const marcado = inboxIds.includes(num.inboxId);
              const parte = selecionados.length > 0 && marcado ? Math.ceil(vaoReceber / selecionados.length) : vaoReceber;
              const dias = diasNecessarios(parte, num.restantesHoje, num.limiteDiario);
              return (
                <label
                  key={num.inboxId}
                  className={cn(
                    'flex items-center gap-3 rounded-[10px] border px-3 py-2.5',
                    num.conectado ? 'cursor-pointer' : 'cursor-not-allowed opacity-60',
                    marcado && 'border-primary bg-primary/5',
                  )}
                >
                  <Checkbox
                    checked={marcado}
                    disabled={!num.conectado}
                    onCheckedChange={() => setInboxIds((x) => alternar(x, num.inboxId))}
                    aria-label={num.nome}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] font-semibold">{num.nome}</span>
                    <span className="block text-xs tabular-nums text-muted-foreground">
                      {num.telefone ? `${formatarTelefone(num.telefone)} · ` : ''}
                      {num.conectado ? descreverCapacidade(num) : 'desconectado · reconecte para usar'}
                    </span>
                  </span>
                  {num.conectado && num.inboxId === recomendado && (
                    <span className="inline-flex h-[22px] items-center rounded-full bg-success/15 px-2.5 text-[11.5px] font-semibold text-success">recomendado</span>
                  )}
                  {num.conectado && vaoReceber > 0 && dias > 1 && (
                    <span className="inline-flex h-[22px] items-center rounded-full bg-warning/15 px-2.5 text-[11.5px] font-semibold text-warning">levaria {dias} dias</span>
                  )}
                  {num.conectado && (num.status === 'nao_aquecido' || num.status === 'pausado') && (
                    <span className={cn('inline-flex h-[22px] items-center rounded-full px-2.5 text-[11.5px] font-semibold', CHIP_STATUS_NUMERO[num.status].classe)}>{rotuloChipNumero(num)}</span>
                  )}
                </label>
              );
            })}
          </fieldset>

          <div className="space-y-2">
            <Label htmlFor="disparo-atende">Quem atende as respostas</Label>
            <Select value={atende} onValueChange={(v) => setAtende(v as AtendeRespostas)}>
              <SelectTrigger id="disparo-atende"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="agente">
                  {selecionados[0]?.agenteNome ? `${selecionados[0].agenteNome} · ` : ''}agente de IA do inbox (sabe que veio deste disparo)
                </SelectItem>
                <SelectItem value="humano">Fila humana — sem IA</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <span className="text-sm font-medium">Quando</span>
              <div className="space-y-2">
                <Segmentado<'agora' | 'agendar'>
                  rotuloGrupo="Quando enviar"
                  valor={quando}
                  onChange={setQuando}
                  opcoes={[{ valor: 'agora', rotulo: 'Agora' }, { valor: 'agendar', rotulo: 'Agendar' }]}
                />
                {quando === 'agendar' && (
                  <div className="space-y-1">
                    <Input type="datetime-local" aria-label="Data e hora do envio" value={agendarLocal} onChange={(e) => setAgendarLocal(e.target.value)} />
                    <p className="text-xs text-muted-foreground">No horário da conta ({fuso.replace('_', ' ')}).</p>
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-sm font-medium">Ritmo</span>
              <p className="text-[13px] leading-snug">
                20 a 60 s entre mensagens, só das 08h às 20h. <span className="text-muted-foreground">Fixo de propósito — é o que evita bloqueio.</span>
              </p>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-[10px] bg-muted px-3.5 py-3" data-testid="resumo-disparo">
            <p className="text-[13px] leading-snug">
              {vaoReceber > 0 && selecionados.length > 0 && termino ? (
                <>
                  <b className="tabular-nums">{vaoReceber}</b> mensagens pelo{selecionados.length > 1 ? 's' : ''} <b>{selecionados.map((x) => x.nome).join(', ')}</b>
                  {' · '}
                  {agendadoPara ? <>começa {formatarDataHora(agendadoPara, fuso)}</> : 'começa agora'}
                  {' · '}termina por volta das <b className="tabular-nums">{formatarHora(termino.toISOString(), fuso)}</b>{' '}
                  {mesmoDia ? 'de hoje' : `de ${formatarDia(termino.toISOString(), fuso)}`}.
                </>
              ) : (
                <span className="text-muted-foreground">Escolha a lista, a mensagem e o número para ver o resumo.</span>
              )}
            </p>
            {pode && <Check className="h-[18px] w-[18px] shrink-0 text-success" aria-hidden="true" />}
          </div>
        </section>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancelar</Button>
          <Button onClick={() => criar.mutate()} disabled={!pode}>
            {criar.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {rotuloBotao}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Passo({ n, titulo }: { n: number; titulo: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold tabular-nums text-primary">{n}</span>
      <h3 className="text-[14.5px] font-semibold">{titulo}</h3>
    </div>
  );
}

function ChipFato({ n, texto }: { n: number; texto: string }) {
  return (
    <span className="inline-flex h-[22px] items-center rounded-full border bg-muted px-2.5 text-[11.5px] font-semibold text-muted-foreground">
      <b className="tabular-nums mr-1">{n}</b> {texto}
    </span>
  );
}
