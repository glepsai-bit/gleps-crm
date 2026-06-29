/**
 * Admin Warmup Page (T-022 FitPark — aquecimento de chips WhatsApp)
 *
 * Layout master-detail:
 *   - Esquerda: cards de WarmupPool (criar/editar/excluir).
 *   - Direita: tabela de WarmupNumber do pool selecionado com badges
 *     de status, currentDay, qualityScore (progress bar) e ações de
 *     ciclo de vida (start/pause/resume/excluir).
 *
 * Estratégia de curva (default 'moderate'):
 *   D1 10 / D2 12 / D3 15 / D4 20 / D5 25 / D6 30 / D7 40 /
 *   D8-14 50-80 / D15-21 100-180 / D22+ 200 estabilizado.
 *
 * Backend:
 *   - src/services/warmup.backend.service.ts
 *   - src/services/inboxes.backend.service.ts (lookup das instâncias Evolution)
 */

import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';

import warmupBackendService, {
  WarmupPool,
  WarmupNumber,
  WarmupNumberStatus,
  WarmupStrategy,
  WarmupDailyStats,
  WarmupTone,
  WarmupAiProviderName,
  WarmupAiProvidersResponse,
  WarmupMedia,
  WarmupMediaType,
  CreatePoolInput,
  CreateNumberInput,
} from '@/services/warmup.backend.service';
import inboxesBackendService, { Inbox } from '@/services/inboxes.backend.service';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Tooltip as UiTooltip,
  TooltipContent as UiTooltipContent,
  TooltipProvider as UiTooltipProvider,
  TooltipTrigger as UiTooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import {
  Plus,
  Pencil,
  Trash2,
  Flame,
  Play,
  Pause,
  RotateCcw,
  BarChart3,
  Mic,
  Sticker,
  Image as ImageIcon,
  Upload,
  Loader2,
} from 'lucide-react';

// ============================================
// Schemas
// ============================================

const poolSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  description: z.string().optional(),
  strategy: z.enum(['conservative', 'moderate', 'aggressive']),
  useAi: z.boolean().optional(),
  aiProvider: z.enum(['openai', 'anthropic']).optional(),
  aiModel: z.string().optional(),
  aiTone: z.enum(['casual', 'formal', 'gym', 'clinic']).optional(),
});
type PoolFormData = z.infer<typeof poolSchema>;

const PHONE_REGEX = /^\+?[1-9]\d{7,14}$/;
const numberSchema = z.object({
  evolutionInstance: z.string().min(1, 'Selecione uma instância Evolution'),
  phoneE164: z
    .string()
    .min(8, 'Telefone obrigatório')
    .regex(
      PHONE_REGEX,
      'Use formato E.164 (ex: +5534993383017 ou 5534993383017)',
    ),
  displayName: z.string().optional(),
});
type NumberFormData = z.infer<typeof numberSchema>;

const STRATEGY_LABELS: Record<WarmupStrategy, string> = {
  conservative: 'Conservadora',
  moderate: 'Moderada (recomendada)',
  aggressive: 'Agressiva',
};

const STATUS_LABELS: Record<WarmupNumberStatus, string> = {
  cold: 'Frio',
  warming: 'Aquecendo',
  warm: 'Quente',
  paused: 'Pausado',
  banned: 'Banido',
  error: 'Erro',
};

/**
 * T-023 — labels visiveis pros providers e tons. Mantemos o valor canonico
 * do backend (openai/anthropic e casual/formal/gym/clinic) e mapeamos pra
 * texto em portugues so na UI.
 */
const PROVIDER_LABELS: Record<WarmupAiProviderName, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

const TONE_LABELS: Record<WarmupTone, string> = {
  casual: 'Casual',
  formal: 'Profissional',
  gym: 'Academia',
  clinic: 'Clínica',
};

// ============================================
// Helpers visuais
// ============================================

function statusBadge(status: WarmupNumberStatus) {
  const label = STATUS_LABELS[status];
  switch (status) {
    case 'cold':
      return <Badge variant="outline">{label}</Badge>;
    case 'warming':
      return (
        <Badge className="bg-green-600 text-white hover:bg-green-600">
          {label}
        </Badge>
      );
    case 'warm':
      return (
        <Badge className="bg-green-800 text-white hover:bg-green-800">
          {label}
        </Badge>
      );
    case 'paused':
      return <Badge variant="secondary">{label}</Badge>;
    case 'banned':
    case 'error':
      return <Badge variant="destructive">{label}</Badge>;
  }
}

function qualityProgressColor(score: number): string {
  if (score >= 80) return 'bg-green-600';
  if (score >= 60) return 'bg-yellow-500';
  return 'bg-red-600';
}

function QualityBar({ score }: { score: number }) {
  const safe = Math.max(0, Math.min(100, Math.round(score)));
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="w-20 h-2 rounded bg-muted overflow-hidden">
        <div
          className={`h-full ${qualityProgressColor(safe)}`}
          style={{ width: `${safe}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">{safe}</span>
    </div>
  );
}

function plannedToday(n: WarmupNumber): number {
  if (!n.dailyEnvioPlan) return 0;
  const key = String(n.currentDay);
  const raw = n.dailyEnvioPlan[key];
  return typeof raw === 'number' ? raw : 0;
}

/**
 * T-023 — badge que indica a origem do conteudo do pool. Cinza
 * "Templates" quando useAi=false (default), roxo "OpenAI" quando o
 * pool usa GPT, verde "Anthropic" quando usa Claude.
 */
function AiSourceBadge({ pool }: { pool: WarmupPool }) {
  if (!pool.useAi) {
    return (
      <Badge variant="secondary" className="text-[10px] py-0">
        Templates
      </Badge>
    );
  }
  if (pool.aiProvider === 'openai') {
    return (
      <Badge className="bg-purple-600 text-white hover:bg-purple-600 text-[10px] py-0">
        OpenAI
      </Badge>
    );
  }
  if (pool.aiProvider === 'anthropic') {
    return (
      <Badge className="bg-green-600 text-white hover:bg-green-600 text-[10px] py-0">
        Anthropic
      </Badge>
    );
  }
  // useAi=true sem provider valido (estado intermediario) -> fallback visual.
  return (
    <Badge variant="outline" className="text-[10px] py-0">
      IA
    </Badge>
  );
}

// ============================================
// Página
// ============================================

export default function AdminWarmupPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedPoolId, setSelectedPoolId] = useState<string | null>(null);

  // T-023 V2 (Phase 4) — qual aba esta ativa no header da pagina.
  // 'pools' = visao atual master-detail; 'media' = biblioteca de midias.
  const [activeTab, setActiveTab] = useState<'pools' | 'media'>('pools');

  // Dialogs
  const [poolDialogOpen, setPoolDialogOpen] = useState(false);
  const [editingPool, setEditingPool] = useState<WarmupPool | null>(null);
  const [deletingPool, setDeletingPool] = useState<WarmupPool | null>(null);

  const [numberDialogOpen, setNumberDialogOpen] = useState(false);
  const [deletingNumber, setDeletingNumber] = useState<WarmupNumber | null>(null);

  const [statsNumberId, setStatsNumberId] = useState<string | null>(null);

  // ----- Queries -----

  const { data: pools = [], isLoading: loadingPools } = useQuery<WarmupPool[]>({
    queryKey: ['warmup-pools'],
    queryFn: () => warmupBackendService.listPools(),
  });

  // Seleciona primeiro pool quando carregar e nada estiver selecionado.
  useEffect(() => {
    if (!selectedPoolId && pools.length > 0) {
      setSelectedPoolId(pools[0].id);
    }
  }, [pools, selectedPoolId]);

  const selectedPool = useMemo(
    () => pools.find((p) => p.id === selectedPoolId) ?? null,
    [pools, selectedPoolId],
  );

  const { data: numbers = [], isLoading: loadingNumbers } = useQuery<WarmupNumber[]>({
    queryKey: ['warmup-numbers', selectedPoolId],
    queryFn: () =>
      warmupBackendService.listNumbers({ poolId: selectedPoolId! }),
    enabled: !!selectedPoolId,
  });

  // Inboxes WhatsApp ativos com evolutionInstance preenchido — usado pra
  // alimentar o select do form "Adicionar chip".
  const { data: inboxes = [] } = useQuery<Inbox[]>({
    queryKey: ['inboxes'],
    queryFn: () => inboxesBackendService.listInboxes(),
  });

  // T-023 — providers de IA disponiveis no backend (env vars setadas) +
  // tons suportados. Usado pra habilitar/desabilitar o checkbox "Usar IA"
  // e popular o select de provider no dialog de pool.
  const { data: aiData } = useQuery<WarmupAiProvidersResponse>({
    queryKey: ['warmup-ai-providers'],
    queryFn: () => warmupBackendService.getAiProviders(),
    staleTime: 5 * 60 * 1000,
  });

  const enabledAiProviders = useMemo(
    () => (aiData?.providers ?? []).filter((p) => p.enabled),
    [aiData],
  );

  // T-023 V2 (Phase 4) — biblioteca de midias da conta + globais. Usada
  // tanto para a aba Midias quanto para mostrar contagens nos cards de pool
  // ("12🔊 5🎴 8🖼️"). Mantemos uma unica query (sem filtro de type) e
  // derivamos os subconjuntos via useMemo abaixo.
  const { data: mediaList = [], isLoading: loadingMedia } = useQuery<
    WarmupMedia[]
  >({
    queryKey: ['warmup-media'],
    queryFn: () => warmupBackendService.listMedia(),
    staleTime: 30 * 1000,
  });

  const mediaCounts = useMemo(() => {
    const counts = { audio: 0, sticker: 0, image: 0 };
    for (const m of mediaList) {
      counts[m.type] += 1;
    }
    return counts;
  }, [mediaList]);

  const totalMediaCount =
    mediaCounts.audio + mediaCounts.sticker + mediaCounts.image;

  const whatsappInstances = useMemo(
    () =>
      inboxes.filter(
        (i) =>
          i.channelType === 'whatsapp' &&
          !!i.evolutionInstance &&
          i.evolutionInstance.trim().length > 0,
      ),
    [inboxes],
  );

  // ----- Mutations: Pool -----

  const mutateCreatePool = useMutation({
    mutationFn: (body: CreatePoolInput) => warmupBackendService.createPool(body),
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['warmup-pools'] });
      toast({ title: 'Pool criada com sucesso!' });
      setPoolDialogOpen(false);
      setSelectedPoolId(created.id);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao criar pool',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateUpdatePool = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CreatePoolInput> }) =>
      warmupBackendService.updatePool(id, body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['warmup-pools'] });
      toast({ title: 'Pool atualizada.' });
      setPoolDialogOpen(false);
      setEditingPool(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao atualizar pool',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateDeletePool = useMutation({
    mutationFn: (id: string) => warmupBackendService.deletePool(id),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ['warmup-pools'] });
      toast({ title: 'Pool excluída.' });
      setDeletingPool(null);
      if (selectedPoolId === id) setSelectedPoolId(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao excluir pool',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // ----- Mutations: Number -----

  const mutateCreateNumber = useMutation({
    mutationFn: (body: CreateNumberInput) => warmupBackendService.createNumber(body),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['warmup-numbers', selectedPoolId],
      });
      toast({ title: 'Chip adicionado ao pool.' });
      setNumberDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao adicionar chip',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateStartNumber = useMutation({
    mutationFn: (id: string) => warmupBackendService.startNumber(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['warmup-numbers', selectedPoolId],
      });
      toast({ title: 'Aquecimento iniciado.' });
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao iniciar',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutatePauseNumber = useMutation({
    mutationFn: (id: string) => warmupBackendService.pauseNumber(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['warmup-numbers', selectedPoolId],
      });
      toast({ title: 'Aquecimento pausado.' });
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao pausar',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateResumeNumber = useMutation({
    mutationFn: (id: string) => warmupBackendService.resumeNumber(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['warmup-numbers', selectedPoolId],
      });
      toast({ title: 'Aquecimento retomado.' });
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao retomar',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  const mutateDeleteNumber = useMutation({
    mutationFn: (id: string) => warmupBackendService.deleteNumber(id),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ['warmup-numbers', selectedPoolId],
      });
      toast({ title: 'Chip removido.' });
      setDeletingNumber(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao remover',
        description: err.message,
        variant: 'destructive',
      });
    },
  });

  // ----- Forms -----

  const poolForm = useForm<PoolFormData>({
    resolver: zodResolver(poolSchema),
    defaultValues: {
      name: '',
      description: '',
      strategy: 'moderate',
      useAi: false,
      aiProvider: undefined,
      aiModel: '',
      aiTone: 'casual',
    },
  });

  const numberForm = useForm<NumberFormData>({
    resolver: zodResolver(numberSchema),
    defaultValues: {
      evolutionInstance: '',
      phoneE164: '',
      displayName: '',
    },
  });

  const abrirCriarPool = () => {
    setEditingPool(null);
    poolForm.reset({
      name: '',
      description: '',
      strategy: 'moderate',
      useAi: false,
      aiProvider: undefined,
      aiModel: '',
      aiTone: 'casual',
    });
    setPoolDialogOpen(true);
  };

  const abrirEditarPool = (pool: WarmupPool) => {
    setEditingPool(pool);
    poolForm.reset({
      name: pool.name,
      description: pool.description ?? '',
      strategy: pool.strategy,
      useAi: pool.useAi,
      aiProvider: pool.aiProvider ?? undefined,
      aiModel: pool.aiModel ?? '',
      aiTone: pool.aiTone ?? 'casual',
    });
    setPoolDialogOpen(true);
  };

  const onSubmitPool = (data: PoolFormData) => {
    // T-023 — quando o usuario nao opta por IA, mandamos useAi=false e
    // limpamos os outros campos pra evitar inconsistencia (provider escolhido
    // sem useAi nao deveria ser persistido). Quando opta por IA, validamos
    // que escolheu um provider habilitado antes de submeter.
    const wantsAi = !!data.useAi;
    if (wantsAi) {
      if (!data.aiProvider) {
        poolForm.setError('aiProvider', {
          type: 'manual',
          message: 'Selecione um provider de IA',
        });
        return;
      }
      const providerStillEnabled = enabledAiProviders.some(
        (p) => p.name === data.aiProvider,
      );
      if (!providerStillEnabled) {
        poolForm.setError('aiProvider', {
          type: 'manual',
          message: 'Provider nao esta mais habilitado no servidor',
        });
        return;
      }
    }

    const aiModelTrimmed = data.aiModel?.trim();
    const body: CreatePoolInput = {
      name: data.name,
      description: data.description?.trim() ? data.description.trim() : null,
      strategy: data.strategy,
      useAi: wantsAi,
      aiProvider: wantsAi ? (data.aiProvider as WarmupAiProviderName) : null,
      aiModel: wantsAi && aiModelTrimmed ? aiModelTrimmed : null,
      aiTone: wantsAi ? (data.aiTone ?? 'casual') : null,
    };
    if (editingPool) {
      mutateUpdatePool.mutate({ id: editingPool.id, body });
    } else {
      mutateCreatePool.mutate(body);
    }
  };

  const abrirAddNumber = () => {
    if (!selectedPoolId) return;
    numberForm.reset({
      evolutionInstance: '',
      phoneE164: '',
      displayName: '',
    });
    setNumberDialogOpen(true);
  };

  const onSubmitNumber = (data: NumberFormData) => {
    if (!selectedPoolId) return;
    mutateCreateNumber.mutate({
      poolId: selectedPoolId,
      evolutionInstance: data.evolutionInstance,
      phoneE164: data.phoneE164,
      displayName: data.displayName?.trim() ? data.displayName.trim() : null,
    });
  };

  const isSavingPool = mutateCreatePool.isPending || mutateUpdatePool.isPending;

  return (
    <div className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Flame className="w-6 h-6 text-orange-500" />
            Aquecimento de Chips
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Eleve a reputação de novos números WhatsApp com tráfego sintético
            entre chips do mesmo pool. Curva D1→D22+ ajustada pela estratégia
            escolhida, com pausas automáticas em caso de queda de qualidade.
          </p>
        </div>
        {activeTab === 'pools' && (
          <Button onClick={abrirCriarPool}>
            <Plus className="w-4 h-4 mr-2" />
            Novo pool
          </Button>
        )}
      </div>

      {/* T-023 V2 (Phase 4) — abas Pools / Midias. A aba Estatisticas
          fica pra V3 (issue futura). */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as 'pools' | 'media')}
      >
        <TabsList>
          <TabsTrigger value="pools">
            Pools{pools.length > 0 ? ` (${pools.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="media">
            Mídias{totalMediaCount > 0 ? ` (${totalMediaCount})` : ''}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="pools" className="mt-4">

      <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-4 lg:gap-6">
        {/* ---------- Coluna esquerda: lista de pools ---------- */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pools ({pools.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {loadingPools ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-16 w-full" />
                ))}
              </div>
            ) : pools.length === 0 ? (
              <div className="text-center py-10 text-sm text-muted-foreground">
                <Flame className="w-8 h-8 mx-auto mb-2 opacity-30" />
                Nenhum pool ainda.
                <br />
                Clique em &quot;Novo pool&quot; para começar.
              </div>
            ) : (
              pools.map((pool) => {
                const active = pool.id === selectedPoolId;
                return (
                  <button
                    key={pool.id}
                    type="button"
                    onClick={() => setSelectedPoolId(pool.id)}
                    className={
                      'w-full text-left rounded-lg border p-3 transition-colors ' +
                      (active
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted/50')
                    }
                    aria-pressed={active}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {pool.name}
                        </p>
                        {pool.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">
                            {pool.description}
                          </p>
                        )}
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          <Badge variant="outline" className="text-[10px] py-0">
                            {STRATEGY_LABELS[pool.strategy]}
                          </Badge>
                          <AiSourceBadge pool={pool} />
                          {!pool.isActive && (
                            <Badge
                              variant="secondary"
                              className="text-[10px] py-0"
                            >
                              Inativo
                            </Badge>
                          )}
                          {/* T-023 V2 (Phase 4) — contagem agregada de
                              midias da conta. Mostramos um unico badge
                              com tooltip que detalha por tipo. Quando
                              zero, badge cinza informando "so texto". */}
                          <PoolMediaBadge
                            audio={mediaCounts.audio}
                            sticker={mediaCounts.sticker}
                            image={mediaCounts.image}
                          />
                        </div>
                      </div>
                      <div className="flex flex-col gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={(e) => {
                            e.stopPropagation();
                            abrirEditarPool(pool);
                          }}
                          aria-label={`Editar pool ${pool.name}`}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeletingPool(pool);
                          }}
                          aria-label={`Excluir pool ${pool.name}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </CardContent>
        </Card>

        {/* ---------- Coluna direita: tabela de números do pool ---------- */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="text-base truncate">
                {selectedPool
                  ? `Chips em ${selectedPool.name}`
                  : 'Selecione um pool'}
              </CardTitle>
              {selectedPool && (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {numbers.length} chip(s) — estratégia{' '}
                  {STRATEGY_LABELS[selectedPool.strategy].toLowerCase()}
                </p>
              )}
            </div>
            {selectedPool && (
              <Button onClick={abrirAddNumber} size="sm">
                <Plus className="w-4 h-4 mr-2" />
                Adicionar chip
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {!selectedPool ? (
              <div className="text-center py-12 text-sm text-muted-foreground">
                Crie ou selecione um pool à esquerda.
              </div>
            ) : loadingNumbers ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-10 w-full" />
                ))}
              </div>
            ) : numbers.length === 0 ? (
              <div className="text-center py-10 text-sm text-muted-foreground">
                Nenhum chip neste pool ainda.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Telefone</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="hidden md:table-cell">
                        Dia
                      </TableHead>
                      <TableHead className="hidden md:table-cell">
                        Quality
                      </TableHead>
                      <TableHead className="hidden lg:table-cell">
                        Enviadas hoje
                      </TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {numbers.map((n) => {
                      const planned = plannedToday(n);
                      return (
                        <TableRow key={n.id}>
                          <TableCell>
                            <div className="flex flex-col">
                              <span className="font-medium">{n.phoneE164}</span>
                              {n.displayName && (
                                <span className="text-xs text-muted-foreground">
                                  {n.displayName}
                                </span>
                              )}
                              <span className="text-[11px] text-muted-foreground opacity-70">
                                {n.evolutionInstance}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell>{statusBadge(n.status)}</TableCell>
                          <TableCell className="hidden md:table-cell">
                            <span className="text-sm tabular-nums">
                              D{n.currentDay}
                            </span>
                          </TableCell>
                          <TableCell className="hidden md:table-cell">
                            <QualityBar score={n.qualityScore} />
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <span className="text-sm tabular-nums">
                              {n.dailyEnviadasHoje}
                              {planned > 0 && (
                                <span className="text-muted-foreground">
                                  {' '}
                                  / {planned}
                                </span>
                              )}
                            </span>
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => setStatsNumberId(n.id)}
                                title="Ver estatísticas"
                                aria-label={`Estatísticas de ${n.phoneE164}`}
                              >
                                <BarChart3 className="w-4 h-4" />
                              </Button>
                              {(n.status === 'cold' || n.status === 'error') && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => mutateStartNumber.mutate(n.id)}
                                  disabled={mutateStartNumber.isPending}
                                  title="Iniciar aquecimento"
                                  aria-label={`Iniciar ${n.phoneE164}`}
                                >
                                  <Play className="w-4 h-4" />
                                </Button>
                              )}
                              {n.status === 'warming' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => mutatePauseNumber.mutate(n.id)}
                                  disabled={mutatePauseNumber.isPending}
                                  title="Pausar"
                                  aria-label={`Pausar ${n.phoneE164}`}
                                >
                                  <Pause className="w-4 h-4" />
                                </Button>
                              )}
                              {n.status === 'paused' && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  onClick={() => mutateResumeNumber.mutate(n.id)}
                                  disabled={mutateResumeNumber.isPending}
                                  title="Retomar"
                                  aria-label={`Retomar ${n.phoneE164}`}
                                >
                                  <RotateCcw className="w-4 h-4" />
                                </Button>
                              )}
                              <Button
                                variant="ghost"
                                size="icon"
                                className="text-destructive hover:text-destructive"
                                onClick={() => setDeletingNumber(n)}
                                title="Excluir"
                                aria-label={`Excluir ${n.phoneE164}`}
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

        </TabsContent>

        <TabsContent value="media" className="mt-4">
          <WarmupMediaLibrary
            mediaList={mediaList}
            isLoading={loadingMedia}
            mediaCounts={mediaCounts}
          />
        </TabsContent>
      </Tabs>

      {/* ============ Dialog: criar / editar pool ============ */}
      <Dialog
        open={poolDialogOpen}
        onOpenChange={(open) => {
          setPoolDialogOpen(open);
          if (!open) setEditingPool(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingPool ? 'Editar pool' : 'Novo pool de aquecimento'}
            </DialogTitle>
            <DialogDescription>
              Pools agrupam chips que conversam entre si. A estratégia define o
              ritmo da curva diária de envios.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={poolForm.handleSubmit(onSubmitPool)}
            className="space-y-4 py-2"
          >
            <div className="space-y-1">
              <Label>Nome</Label>
              <Input
                {...poolForm.register('name')}
                placeholder="Ex: Pool comercial Gleps"
              />
              {poolForm.formState.errors.name && (
                <p className="text-xs text-destructive">
                  {poolForm.formState.errors.name.message}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Descrição (opcional)</Label>
              <Textarea
                rows={2}
                {...poolForm.register('description')}
                placeholder="Para o que esse pool é usado?"
              />
            </div>

            <div className="space-y-1">
              <Label>Estratégia</Label>
              <Select
                value={poolForm.watch('strategy')}
                onValueChange={(v) =>
                  poolForm.setValue('strategy', v as WarmupStrategy, {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="conservative">
                    {STRATEGY_LABELS.conservative}
                  </SelectItem>
                  <SelectItem value="moderate">
                    {STRATEGY_LABELS.moderate}
                  </SelectItem>
                  <SelectItem value="aggressive">
                    {STRATEGY_LABELS.aggressive}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Moderada: D1=10, D7=40, D14=80, D21=180, D22+ estabiliza em 200
                envios/dia.
              </p>
            </div>

            {/* T-023 — secao opcional de IA. Default unchecked. Desabilita
                quando nenhum provider esta habilitado no servidor. */}
            <div className="space-y-3 rounded-md border bg-muted/40 p-3">
              <div className="flex items-start gap-2">
                <Checkbox
                  id="pool-use-ai"
                  checked={!!poolForm.watch('useAi')}
                  disabled={!aiData?.anyEnabled}
                  onCheckedChange={(checked) => {
                    const enabled = checked === true;
                    poolForm.setValue('useAi', enabled, {
                      shouldValidate: true,
                    });
                    // Pre-seleciona o primeiro provider habilitado quando
                    // o usuario marca o checkbox sem nenhum provider escolhido.
                    if (
                      enabled &&
                      !poolForm.getValues('aiProvider') &&
                      enabledAiProviders.length > 0
                    ) {
                      poolForm.setValue(
                        'aiProvider',
                        enabledAiProviders[0].name,
                        { shouldValidate: true },
                      );
                    }
                    poolForm.clearErrors('aiProvider');
                  }}
                />
                <div className="space-y-0.5">
                  <Label
                    htmlFor="pool-use-ai"
                    className="cursor-pointer text-sm font-medium"
                  >
                    Usar IA pra gerar mensagens (opcional)
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {aiData?.anyEnabled
                      ? 'Quando ativo, o conteudo das conversas sinteticas e gerado por IA. Caso falhe, cai automaticamente nos templates do banco.'
                      : 'Nenhum provedor de IA configurado. Configure OPENAI_API_KEY ou ANTHROPIC_API_KEY no backend para habilitar.'}
                  </p>
                </div>
              </div>

              {poolForm.watch('useAi') && aiData?.anyEnabled && (
                <div className="space-y-3 pl-6">
                  <div className="space-y-1">
                    <Label>Provedor de IA</Label>
                    <Select
                      value={poolForm.watch('aiProvider') ?? ''}
                      onValueChange={(v) => {
                        poolForm.setValue(
                          'aiProvider',
                          v as WarmupAiProviderName,
                          { shouldValidate: true },
                        );
                        poolForm.clearErrors('aiProvider');
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Selecione um provedor" />
                      </SelectTrigger>
                      <SelectContent>
                        {enabledAiProviders.map((p) => (
                          <SelectItem key={p.name} value={p.name}>
                            {PROVIDER_LABELS[p.name]} ({p.defaultModel})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {poolForm.formState.errors.aiProvider && (
                      <p className="text-xs text-destructive">
                        {poolForm.formState.errors.aiProvider.message}
                      </p>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label>Tom da conversa</Label>
                    <Select
                      value={poolForm.watch('aiTone') ?? 'casual'}
                      onValueChange={(v) =>
                        poolForm.setValue('aiTone', v as WarmupTone, {
                          shouldValidate: true,
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(aiData?.supportedTones ?? [
                          'casual',
                          'formal',
                          'gym',
                          'clinic',
                        ]).map((t) => (
                          <SelectItem key={t} value={t}>
                            {TONE_LABELS[t]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <Label>Modelo customizado (opcional)</Label>
                    <Input
                      {...poolForm.register('aiModel')}
                      placeholder={
                        enabledAiProviders.find(
                          (p) => p.name === poolForm.watch('aiProvider'),
                        )?.defaultModel ?? 'Padrao do provider'
                      }
                    />
                    <p className="text-xs text-muted-foreground">
                      Em branco usa o modelo padrao do provider selecionado.
                    </p>
                  </div>
                </div>
              )}
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setPoolDialogOpen(false);
                  setEditingPool(null);
                }}
                disabled={isSavingPool}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={isSavingPool}>
                {isSavingPool
                  ? 'Salvando...'
                  : editingPool
                    ? 'Salvar alterações'
                    : 'Criar pool'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ============ Dialog: adicionar chip ============ */}
      <Dialog open={numberDialogOpen} onOpenChange={setNumberDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Adicionar chip ao pool</DialogTitle>
            <DialogDescription>
              O chip começa em status &quot;Frio&quot;. Use o botão Play para
              gerar o plano de envios e iniciar o aquecimento.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={numberForm.handleSubmit(onSubmitNumber)}
            className="space-y-4 py-2"
          >
            <div className="space-y-1">
              <Label>Instância Evolution</Label>
              <Select
                value={numberForm.watch('evolutionInstance')}
                onValueChange={(v) =>
                  numberForm.setValue('evolutionInstance', v, {
                    shouldValidate: true,
                  })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Selecione um canal WhatsApp" />
                </SelectTrigger>
                <SelectContent>
                  {whatsappInstances.length === 0 ? (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Nenhum inbox WhatsApp com instância configurada.
                      <br />
                      Configure em /admin/inboxes primeiro.
                    </div>
                  ) : (
                    whatsappInstances.map((i) => (
                      <SelectItem
                        key={i.id}
                        value={i.evolutionInstance as string}
                      >
                        {i.name} — {i.evolutionInstance}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {numberForm.formState.errors.evolutionInstance && (
                <p className="text-xs text-destructive">
                  {numberForm.formState.errors.evolutionInstance.message}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Telefone (E.164)</Label>
              <Input
                {...numberForm.register('phoneE164')}
                placeholder="+5534993383017"
              />
              {numberForm.formState.errors.phoneE164 && (
                <p className="text-xs text-destructive">
                  {numberForm.formState.errors.phoneE164.message}
                </p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Apelido (opcional)</Label>
              <Input
                {...numberForm.register('displayName')}
                placeholder="Chip atendimento 01"
              />
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNumberDialogOpen(false)}
                disabled={mutateCreateNumber.isPending}
              >
                Cancelar
              </Button>
              <Button type="submit" disabled={mutateCreateNumber.isPending}>
                {mutateCreateNumber.isPending ? 'Adicionando...' : 'Adicionar'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ============ AlertDialog: excluir pool ============ */}
      <AlertDialog
        open={!!deletingPool}
        onOpenChange={(open) => {
          if (!open) setDeletingPool(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Excluir pool?
            </AlertDialogTitle>
            <AlertDialogDescription>
              A pool <strong>{deletingPool?.name}</strong> e todos os chips
              vinculados serão removidos. Esta ação é irreversível.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutateDeletePool.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={mutateDeletePool.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deletingPool) mutateDeletePool.mutate(deletingPool.id);
              }}
            >
              {mutateDeletePool.isPending ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ============ AlertDialog: excluir chip ============ */}
      <AlertDialog
        open={!!deletingNumber}
        onOpenChange={(open) => {
          if (!open) setDeletingNumber(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Remover chip do pool?
            </AlertDialogTitle>
            <AlertDialogDescription>
              O chip <strong>{deletingNumber?.phoneE164}</strong> e seu
              histórico de envios serão apagados. Esta ação é irreversível.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutateDeleteNumber.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={mutateDeleteNumber.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deletingNumber)
                  mutateDeleteNumber.mutate(deletingNumber.id);
              }}
            >
              {mutateDeleteNumber.isPending ? 'Removendo...' : 'Remover'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ============ Dialog: estatísticas do chip ============ */}
      <NumberStatsDialog
        numberId={statsNumberId}
        onOpenChange={(open) => {
          if (!open) setStatsNumberId(null);
        }}
      />

      {/* Suppress unused import warning for Progress (UI shadcn que pode ser usada futuramente) */}
      <Progress className="hidden" value={0} />
    </div>
  );
}

// ============================================
// PoolMediaBadge — agregado de midias disponiveis na conta.
// Mostra contagem por tipo com icone + tooltip explicando o impacto
// quando nao ha midia configurada (sistema cai pra so-texto).
// ============================================

function PoolMediaBadge({
  audio,
  sticker,
  image,
}: {
  audio: number;
  sticker: number;
  image: number;
}) {
  const total = audio + sticker + image;
  const labelTooltip =
    total === 0
      ? 'Sem mídias cadastradas — o sistema usará apenas texto nas conversas.'
      : `Mídias disponíveis para esta conta: ${audio} áudios, ${sticker} figurinhas, ${image} imagens. Distribuídas conforme a fase do protocolo.`;
  return (
    <UiTooltipProvider delayDuration={150}>
      <UiTooltip>
        <UiTooltipTrigger asChild>
          <Badge
            variant={total === 0 ? 'outline' : 'secondary'}
            className="text-[10px] py-0 inline-flex items-center gap-1 cursor-help"
            aria-label="Contagem de mídias da conta"
          >
            <Mic className="w-3 h-3" />
            {audio}
            <Sticker className="w-3 h-3 ml-1" />
            {sticker}
            <ImageIcon className="w-3 h-3 ml-1" />
            {image}
          </Badge>
        </UiTooltipTrigger>
        <UiTooltipContent side="bottom" className="max-w-xs">
          {labelTooltip}
        </UiTooltipContent>
      </UiTooltip>
    </UiTooltipProvider>
  );
}

// ============================================
// WarmupMediaLibrary (T-023 V2 / Phase 4)
// 3 cards lado a lado (audio | sticker | image) com upload + listagem.
// Validacao client-side de tamanho antes do upload. Apaga via AlertDialog.
// ============================================

type MediaCardConfig = {
  type: WarmupMediaType;
  label: string;
  pluralLabel: string;
  emoji: string;
  icon: typeof Mic;
  accept: string;
  maxBytes: number;
  helpText: string;
};

const MEDIA_CARDS: MediaCardConfig[] = [
  {
    type: 'audio',
    label: 'Áudio',
    pluralLabel: 'áudios',
    emoji: '🔊',
    icon: Mic,
    accept: '.ogg,.mp3,.wav,.m4a,audio/*',
    maxBytes: 1 * 1024 * 1024,
    helpText: 'OGG, MP3, WAV ou M4A • até 1 MB • 3-8 s recomendado',
  },
  {
    type: 'sticker',
    label: 'Figurinha',
    pluralLabel: 'figurinhas',
    emoji: '🎴',
    icon: Sticker,
    accept: '.webp,image/webp',
    maxBytes: 200 * 1024,
    helpText: 'WebP • até 200 KB • figurinha WhatsApp 512×512',
  },
  {
    type: 'image',
    label: 'Imagem',
    pluralLabel: 'imagens',
    emoji: '🖼️',
    icon: ImageIcon,
    accept: '.jpg,.jpeg,.png,.webp,image/*',
    maxBytes: 2 * 1024 * 1024,
    helpText: 'JPG, PNG ou WebP • até 2 MB',
  },
];

function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function WarmupMediaLibrary({
  mediaList,
  isLoading,
  mediaCounts,
}: {
  mediaList: WarmupMedia[];
  isLoading: boolean;
  mediaCounts: { audio: number; sticker: number; image: number };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [deletingMedia, setDeletingMedia] = useState<WarmupMedia | null>(null);
  const [uploadingType, setUploadingType] = useState<WarmupMediaType | null>(
    null,
  );

  const mutateUpload = useMutation({
    mutationFn: ({
      file,
      type,
    }: {
      file: File;
      type: WarmupMediaType;
    }) => warmupBackendService.uploadMedia(file, type),
    onMutate: ({ type }) => {
      setUploadingType(type);
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: ['warmup-media'] });
      toast({
        title: 'Mídia adicionada',
        description: created.fileName ?? created.id,
      });
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao enviar mídia',
        description: err.message,
        variant: 'destructive',
      });
    },
    onSettled: () => {
      setUploadingType(null);
    },
  });

  const mutateDelete = useMutation({
    mutationFn: (id: string) => warmupBackendService.deleteMedia(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['warmup-media'] });
      toast({ title: 'Mídia removida.' });
      setDeletingMedia(null);
    },
    onError: (err: Error) => {
      toast({
        title: 'Erro ao remover mídia',
        description: err.message,
        variant: 'destructive',
      });
      setDeletingMedia(null);
    },
  });

  const totalMedia =
    mediaCounts.audio + mediaCounts.sticker + mediaCounts.image;

  const handleFileSelected = (
    config: MediaCardConfig,
    fileList: FileList | null,
    inputEl: HTMLInputElement,
  ) => {
    const file = fileList?.[0];
    // Reseta o input pra permitir reupload do mesmo arquivo depois.
    inputEl.value = '';
    if (!file) return;

    if (file.size > config.maxBytes) {
      toast({
        title: 'Arquivo muito grande',
        description: `${config.label} aceita até ${formatBytes(config.maxBytes)}. Arquivo selecionado: ${formatBytes(file.size)}.`,
        variant: 'destructive',
      });
      return;
    }
    mutateUpload.mutate({ file, type: config.type });
  };

  return (
    <div className="space-y-4">
      {/* Aviso UX explicando impacto de nao ter midias. */}
      <div
        className={
          'rounded-md border p-4 text-sm ' +
          (totalMedia === 0
            ? 'border-yellow-500/40 bg-yellow-500/10 text-yellow-900 dark:text-yellow-100'
            : 'border-muted bg-muted/40 text-muted-foreground')
        }
        role="status"
      >
        <p>
          <strong>
            {totalMedia === 0
              ? 'Sem mídias configuradas.'
              : `${totalMedia} mídia(s) disponível(is).`}
          </strong>{' '}
          {totalMedia === 0
            ? 'O sistema usa apenas texto. Adicionar áudios curtos (3-8 s), figurinhas WhatsApp e imagens reduz o padrão de bot detectado pela Meta.'
            : 'O cron de aquecimento alterna texto e mídia conforme a fase do protocolo (D4+ libera áudio; D8+ libera figurinha/imagem).'}
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {MEDIA_CARDS.map((config) => {
          const items = mediaList.filter((m) => m.type === config.type);
          const Icon = config.icon;
          const isUploadingThis =
            uploadingType === config.type && mutateUpload.isPending;
          return (
            <Card key={config.type} className="flex flex-col">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Icon className="w-4 h-4" />
                    {config.label}
                    <span className="text-xs font-normal text-muted-foreground">
                      ({items.length} {config.pluralLabel})
                    </span>
                  </CardTitle>
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {config.helpText}
                </p>
              </CardHeader>
              <CardContent className="flex-1 space-y-3">
                <div>
                  <label
                    htmlFor={`warmup-upload-${config.type}`}
                    className={
                      'inline-flex items-center gap-2 rounded-md border border-dashed px-3 py-2 text-sm cursor-pointer w-full justify-center transition-colors ' +
                      (isUploadingThis
                        ? 'opacity-60 cursor-wait'
                        : 'hover:bg-muted/50')
                    }
                  >
                    {isUploadingThis ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Upload className="w-4 h-4" />
                    )}
                    {isUploadingThis ? 'Enviando...' : 'Adicionar'}
                    <input
                      id={`warmup-upload-${config.type}`}
                      type="file"
                      accept={config.accept}
                      className="hidden"
                      disabled={isUploadingThis}
                      onChange={(e) =>
                        handleFileSelected(
                          config,
                          e.target.files,
                          e.currentTarget,
                        )
                      }
                    />
                  </label>
                </div>

                {isLoading ? (
                  <div className="space-y-2">
                    {[1, 2].map((i) => (
                      <Skeleton key={i} className="h-12 w-full" />
                    ))}
                  </div>
                ) : items.length === 0 ? (
                  <div className="text-center py-6 text-xs text-muted-foreground border border-dashed rounded">
                    Nenhuma {config.label.toLowerCase()} ainda.
                  </div>
                ) : (
                  <ul className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                    {items.map((m) => (
                      <li
                        key={m.id}
                        className="rounded border p-2 text-xs flex flex-col gap-2"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p
                              className="font-medium truncate"
                              title={m.fileName ?? m.id}
                            >
                              {m.fileName ?? '(sem nome)'}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {formatBytes(m.mediaSizeBytes)}
                              {m.isGlobal && (
                                <span className="ml-2">
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] py-0"
                                  >
                                    Global
                                  </Badge>
                                </span>
                              )}
                            </p>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive shrink-0"
                            onClick={() => setDeletingMedia(m)}
                            aria-label={`Excluir ${m.fileName ?? m.id}`}
                            disabled={m.isGlobal}
                            title={
                              m.isGlobal
                                ? 'Mídias globais não podem ser removidas por admin'
                                : 'Excluir mídia'
                            }
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                        {/* Preview do conteudo */}
                        {m.mediaUrl ? (
                          config.type === 'audio' ? (
                            <audio
                              src={m.mediaUrl}
                              controls
                              preload="none"
                              className="w-full h-8"
                            />
                          ) : (
                            <img
                              src={m.mediaUrl}
                              alt={m.fileName ?? config.label}
                              className="max-h-32 w-full object-contain bg-muted rounded"
                              loading="lazy"
                            />
                          )
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog
        open={!!deletingMedia}
        onOpenChange={(open) => {
          if (!open) setDeletingMedia(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-destructive">
              Excluir mídia?
            </AlertDialogTitle>
            <AlertDialogDescription>
              O arquivo <strong>{deletingMedia?.fileName ?? deletingMedia?.id}</strong>{' '}
              será removido permanentemente e deixará de ser usado nas
              conversas de aquecimento.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={mutateDelete.isPending}>
              Cancelar
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={mutateDelete.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deletingMedia) mutateDelete.mutate(deletingMedia.id);
              }}
            >
              {mutateDelete.isPending ? 'Excluindo...' : 'Excluir'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ============================================
// NumberStatsDialog — gráfico simples com últimos 30 dias.
// Mostra planned vs actual por dia (BarChart Recharts).
// ============================================

function NumberStatsDialog({
  numberId,
  onOpenChange,
}: {
  numberId: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const isOpen = !!numberId;
  const { data: stats = [], isLoading } = useQuery<WarmupDailyStats[]>({
    queryKey: ['warmup-stats', numberId],
    queryFn: () => warmupBackendService.getStats(numberId!),
    enabled: isOpen,
  });

  // Recharts pede data ordenada cronologicamente; backend pode devolver
  // qualquer ordem — ordenamos defensivamente.
  const chartData = useMemo(
    () =>
      [...stats]
        .sort((a, b) => (a.date < b.date ? -1 : 1))
        .map((s) => ({
          date: s.date.slice(5), // MM-DD pra economizar espaço
          planejado: s.plannedSends,
          enviado: s.actualSends,
          falhas: s.failedSends,
        })),
    [stats],
  );

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Estatísticas de envio (últimos 30 dias)</DialogTitle>
          <DialogDescription>
            Comparativo entre planejado pela curva e realmente enviado.
          </DialogDescription>
        </DialogHeader>
        <div className="py-4">
          {isLoading ? (
            <Skeleton className="h-64 w-full" />
          ) : chartData.length === 0 ? (
            <div className="text-center py-12 text-sm text-muted-foreground">
              Sem estatísticas ainda. O chip precisa rodar pelo menos um dia
              para gerar dados.
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" fontSize={11} />
                  <YAxis fontSize={11} />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="planejado" fill="#94a3b8" />
                  <Bar dataKey="enviado" fill="#16a34a" />
                  <Bar dataKey="falhas" fill="#dc2626" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
