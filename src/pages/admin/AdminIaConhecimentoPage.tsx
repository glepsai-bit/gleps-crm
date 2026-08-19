/**
 * AdminIaConhecimentoPage (T-027 Fase 1)
 *
 * Base de conhecimento (RAG): o material do negócio que a IA pode usar como
 * fato — tabela de preços, objeções, política de cancelamento. Sai do prompt
 * gigante e vira documento pesquisável.
 *
 * A indexação é ASSÍNCRONA (worker de 30s), então a tela mostra o status por
 * documento e faz poll enquanto houver algo em fila — sem isso o admin sobe um
 * documento e não sabe se já pode testar.
 *
 * Serviço: src/services/ai.backend.service.ts
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  aiService,
  KnowledgeBase,
  KnowledgeDoc,
  KnowledgeHit,
} from '@/services/ai.backend.service';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Trash2,
  BookOpen,
  FileText,
  RefreshCw,
  Search,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  Clock,
  XCircle,
  Upload,
} from 'lucide-react';

const STATUS_META: Record<
  KnowledgeDoc['status'],
  { label: string; icon: typeof Clock; className: string }
> = {
  pending: { label: 'Na fila', icon: Clock, className: 'text-muted-foreground' },
  indexing: { label: 'Indexando', icon: Loader2, className: 'text-blue-600' },
  ready: { label: 'Pronto', icon: CheckCircle2, className: 'text-emerald-600' },
  failed: { label: 'Falhou', icon: XCircle, className: 'text-destructive' },
};

/** Extensões que dá pra ler como texto puro no navegador. */
const TEXT_FILE_ACCEPT = '.txt,.md,.csv,.json,text/plain,text/markdown,text/csv';

export default function AdminIaConhecimentoPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedBaseId, setSelectedBaseId] = useState<string | null>(null);
  const [baseDialogOpen, setBaseDialogOpen] = useState(false);
  const [baseForm, setBaseForm] = useState({ name: '', description: '' });
  const [deletingBase, setDeletingBase] = useState<KnowledgeBase | null>(null);

  const [docDialogOpen, setDocDialogOpen] = useState(false);
  const [docForm, setDocForm] = useState({ title: '', content: '' });
  const [deletingDoc, setDeletingDoc] = useState<KnowledgeDoc | null>(null);

  const [testQuery, setTestQuery] = useState('');
  const [testHits, setTestHits] = useState<KnowledgeHit[] | null>(null);

  const statusQuery = useQuery({ queryKey: ['ai', 'status'], queryFn: aiService.getStatus });
  const basesQuery = useQuery({
    queryKey: ['ai', 'bases'],
    queryFn: aiService.listBases,
  });

  const activeBaseId = selectedBaseId ?? basesQuery.data?.[0]?.id ?? null;
  const activeBase = basesQuery.data?.find((b) => b.id === activeBaseId) ?? null;

  const docsQuery = useQuery({
    queryKey: ['ai', 'docs', activeBaseId],
    queryFn: () => aiService.listDocs(activeBaseId!),
    enabled: !!activeBaseId,
    // Poll enquanto houver documento em fila/indexando: o worker roda a cada
    // 30s e sem isso a tela ficaria em "Na fila" até um F5 manual.
    refetchInterval: (query) => {
      const docs = query.state.data as KnowledgeDoc[] | undefined;
      const working = docs?.some((d) => d.status === 'pending' || d.status === 'indexing');
      return working ? 5000 : false;
    },
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['ai', 'bases'] });
    queryClient.invalidateQueries({ queryKey: ['ai', 'docs', activeBaseId] });
  };

  const createBaseMutation = useMutation({
    mutationFn: () =>
      aiService.createBase({ name: baseForm.name, description: baseForm.description || null }),
    onSuccess: (base) => {
      invalidateAll();
      setSelectedBaseId(base.id);
      setBaseDialogOpen(false);
      setBaseForm({ name: '', description: '' });
      toast({ title: 'Base criada' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível criar', description: err.message, variant: 'destructive' }),
  });

  const deleteBaseMutation = useMutation({
    mutationFn: (id: string) => aiService.deleteBase(id),
    onSuccess: () => {
      setSelectedBaseId(null);
      setDeletingBase(null);
      invalidateAll();
      toast({ title: 'Base excluída' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível excluir', description: err.message, variant: 'destructive' }),
  });

  const createDocMutation = useMutation({
    mutationFn: () => aiService.createDoc(activeBaseId!, docForm),
    onSuccess: () => {
      invalidateAll();
      setDocDialogOpen(false);
      setDocForm({ title: '', content: '' });
      toast({
        title: 'Documento enviado',
        description: 'A indexação roda em segundo plano — o status atualiza sozinho.',
      });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível enviar', description: err.message, variant: 'destructive' }),
  });

  const deleteDocMutation = useMutation({
    mutationFn: (id: string) => aiService.deleteDoc(id),
    onSuccess: () => {
      setDeletingDoc(null);
      invalidateAll();
      toast({ title: 'Documento excluído' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível excluir', description: err.message, variant: 'destructive' }),
  });

  const reindexMutation = useMutation({
    mutationFn: (id: string) => aiService.reindexDoc(id),
    onSuccess: () => {
      invalidateAll();
      toast({ title: 'Documento recolocado na fila' });
    },
    onError: (err: Error) =>
      toast({ title: 'Não foi possível reindexar', description: err.message, variant: 'destructive' }),
  });

  const searchMutation = useMutation({
    mutationFn: () => aiService.searchBase(activeBaseId!, testQuery),
    onSuccess: (hits) => setTestHits(hits),
    onError: (err: Error) =>
      toast({ title: 'A busca falhou', description: err.message, variant: 'destructive' }),
  });

  const handleFile = async (file: File) => {
    const content = await file.text();
    setDocForm({ title: file.name.replace(/\.[^.]+$/, ''), content });
  };

  const kbUnavailable = statusQuery.data && !statusQuery.data.knowledgeBaseReady;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <BookOpen className="w-6 h-6" /> Base de conhecimento
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            O que a IA pode afirmar sobre o seu negócio. Suba os documentos aqui em vez de inflar
            o prompt.
          </p>
        </div>
        <Button onClick={() => setBaseDialogOpen(true)}>
          <Plus className="w-4 h-4 mr-2" /> Nova base
        </Button>
      </div>

      {kbUnavailable && (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            A base de conhecimento precisa de uma <strong>chave OpenAI</strong> — a Anthropic não
            oferece embeddings. Cadastre em <strong>Administração → Integrações</strong>; sem ela
            os documentos ficam parados em “Na fila”.
          </AlertDescription>
        </Alert>
      )}

      {basesQuery.isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : basesQuery.data?.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="font-medium">Nenhuma base ainda</p>
            <p className="text-sm mt-1">
              Crie uma base por assunto — “Produto e preços”, “Objeções”, “Políticas”.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
          {/* Lista de bases */}
          <div className="space-y-2">
            {basesQuery.data?.map((base) => (
              <button
                key={base.id}
                onClick={() => {
                  setSelectedBaseId(base.id);
                  setTestHits(null);
                }}
                className={`w-full text-left rounded-md border p-3 transition-colors ${
                  base.id === activeBaseId ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'
                }`}
              >
                <p className="font-medium text-sm truncate">{base.name}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {base.docCount} doc(s) · {base.chunkCount} trechos
                </p>
              </button>
            ))}
          </div>

          {/* Documentos da base ativa */}
          <div className="space-y-4">
            {activeBase && (
              <>
                <Card>
                  <CardHeader className="pb-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CardTitle className="text-base truncate">{activeBase.name}</CardTitle>
                        {activeBase.description && (
                          <p className="text-xs text-muted-foreground mt-1">
                            {activeBase.description}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" onClick={() => setDocDialogOpen(true)}>
                          <Plus className="w-4 h-4 mr-1.5" /> Documento
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setDeletingBase(activeBase)}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-2">
                    {docsQuery.isLoading ? (
                      <Skeleton className="h-20 w-full" />
                    ) : docsQuery.data?.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-6 text-center">
                        Nenhum documento nesta base.
                      </p>
                    ) : (
                      docsQuery.data?.map((doc) => {
                        const meta = STATUS_META[doc.status];
                        const Icon = meta.icon;
                        return (
                          <div
                            key={doc.id}
                            className="flex items-start justify-between gap-3 rounded-md border p-3"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
                                <span className="font-medium text-sm truncate">{doc.title}</span>
                              </div>
                              <div className="flex items-center gap-2 mt-1 flex-wrap">
                                <span
                                  className={`inline-flex items-center gap-1 text-xs ${meta.className}`}
                                >
                                  <Icon
                                    className={`w-3 h-3 ${doc.status === 'indexing' ? 'animate-spin' : ''}`}
                                  />
                                  {meta.label}
                                </span>
                                {doc.status === 'ready' && (
                                  <Badge variant="outline" className="text-xs">
                                    {doc.chunkCount} trechos
                                  </Badge>
                                )}
                              </div>
                              {doc.error && (
                                <p className="text-xs text-destructive mt-1 break-words">
                                  {doc.error}
                                </p>
                              )}
                            </div>
                            <div className="flex gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                title="Reindexar"
                                onClick={() => reindexMutation.mutate(doc.id)}
                              >
                                <RefreshCw className="w-4 h-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setDeletingDoc(doc)}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </CardContent>
                </Card>

                {/* Testar a busca sem gastar o agente */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-sm flex items-center gap-2">
                      <Search className="w-4 h-4" /> Testar a busca
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Input
                        value={testQuery}
                        onChange={(e) => setTestQuery(e.target.value)}
                        placeholder="Pergunte como um lead perguntaria"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && testQuery.trim()) searchMutation.mutate();
                        }}
                      />
                      <Button
                        onClick={() => searchMutation.mutate()}
                        disabled={!testQuery.trim() || searchMutation.isPending}
                      >
                        {searchMutation.isPending ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Search className="w-4 h-4" />
                        )}
                      </Button>
                    </div>

                    {testHits && (
                      <div className="space-y-2">
                        {testHits.length === 0 ? (
                          <p className="text-xs text-muted-foreground">
                            Nenhum trecho passou do corte de relevância. A IA responderia sem a
                            base nesse caso.
                          </p>
                        ) : (
                          testHits.map((h) => (
                            <div key={h.chunkId} className="rounded-md border p-2.5">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium truncate">
                                  {h.docTitle || 'sem título'}
                                </span>
                                <Badge variant="outline" className="text-xs shrink-0">
                                  {(h.score * 100).toFixed(0)}%
                                </Badge>
                              </div>
                              <p className="text-xs text-muted-foreground mt-1 line-clamp-3">
                                {h.content}
                              </p>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </div>
        </div>
      )}

      {/* ---------- Nova base ---------- */}
      <Dialog open={baseDialogOpen} onOpenChange={setBaseDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nova base de conhecimento</DialogTitle>
            <DialogDescription>
              Agrupe por assunto — o agente aponta para uma base de cada vez.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="kb-nome">Nome</Label>
              <Input
                id="kb-nome"
                value={baseForm.name}
                onChange={(e) => setBaseForm({ ...baseForm, name: e.target.value })}
                placeholder="Produto e preços"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="kb-desc">Descrição</Label>
              <Input
                id="kb-desc"
                value={baseForm.description}
                onChange={(e) => setBaseForm({ ...baseForm, description: e.target.value })}
                placeholder="O que esta base cobre"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBaseDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => createBaseMutation.mutate()}
              disabled={!baseForm.name.trim() || createBaseMutation.isPending}
            >
              {createBaseMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- Novo documento ---------- */}
      <Dialog open={docDialogOpen} onOpenChange={setDocDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Novo documento</DialogTitle>
            <DialogDescription>
              Cole o texto ou envie um arquivo de texto (.txt, .md, .csv, .json).
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="doc-titulo">Título</Label>
              <Input
                id="doc-titulo"
                value={docForm.title}
                onChange={(e) => setDocForm({ ...docForm, title: e.target.value })}
                placeholder="Tabela de preços 2026"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-arquivo" className="flex items-center gap-2">
                <Upload className="w-4 h-4" /> Arquivo de texto (opcional)
              </Label>
              <Input
                id="doc-arquivo"
                type="file"
                accept={TEXT_FILE_ACCEPT}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void handleFile(file);
                }}
              />
              <p className="text-xs text-muted-foreground">
                PDF e DOCX ainda não são lidos aqui — copie o texto e cole abaixo.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="doc-conteudo">Conteúdo</Label>
              <Textarea
                id="doc-conteudo"
                value={docForm.content}
                onChange={(e) => setDocForm({ ...docForm, content: e.target.value })}
                className="min-h-[240px] font-mono text-xs"
                placeholder="Cole aqui o material do negócio…"
              />
              <p className="text-xs text-muted-foreground">
                {docForm.content.length.toLocaleString('pt-BR')} caracteres
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDocDialogOpen(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => createDocMutation.mutate()}
              disabled={
                !docForm.title.trim() || !docForm.content.trim() || createDocMutation.isPending
              }
            >
              {createDocMutation.isPending && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              Enviar para indexação
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deletingBase} onOpenChange={(open) => !open && setDeletingBase(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir “{deletingBase?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Todos os documentos e trechos indexados dessa base são apagados. Agentes vinculados
              continuam funcionando, mas sem base de conhecimento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingBase && deleteBaseMutation.mutate(deletingBase.id)}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deletingDoc} onOpenChange={(open) => !open && setDeletingDoc(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir “{deletingDoc?.title}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Os trechos indexados desse documento saem da base imediatamente.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingDoc && deleteDocMutation.mutate(deletingDoc.id)}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
