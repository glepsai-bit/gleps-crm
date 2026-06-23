import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Send, CheckCircle2, UserMinus, Zap, Filter } from 'lucide-react';

interface CampaignBatch {
  id: string;
  keyword: string | null;
  location: string | null;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  status: string;
  source: string;
  trigger_name: string | null;
  scheduled_at: string | null;
  started_at: string;
  created_at: string;
}

interface CampaignMetrics {
  total_enviadas: number;
  taxa_entrega: number;
  opt_outs: number;
  campanhas_ativas: number;
}

type Periodo = '7d' | '30d';
type SourceFiltro = 'todas' | 'manual' | 'manual_scheduled' | 'n8n' | 'api';

function getStatusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed': return 'default';
    case 'running': return 'secondary';
    case 'cancelled': return 'outline';
    case 'scheduled': return 'outline';
    default: return 'destructive';
  }
}

function getStatusLabel(status: string) {
  switch (status) {
    case 'completed': return 'Concluído';
    case 'running': return 'Em andamento';
    case 'cancelled': return 'Cancelado';
    case 'scheduled': return 'Agendado';
    default: return status;
  }
}

function getSourceLabel(source: string) {
  switch (source) {
    case 'manual': return 'Manual';
    case 'manual_scheduled': return 'Agendado';
    case 'n8n': return 'n8n';
    case 'api': return 'API';
    default: return source;
  }
}

interface Props {
  accountId: string;
}

export function CampaignDashboard({ accountId }: Props) {
  const [periodo, setPeriodo] = useState<Periodo>('30d');
  const [sourceFiltro, setSourceFiltro] = useState<SourceFiltro>('todas');
  const [triggerFiltro, setTriggerFiltro] = useState('');

  // TODO: backend pendente — endpoint de métricas de campanhas ainda sendo implementado
  const { data: metrics, isLoading: loadingMetrics } = useQuery<CampaignMetrics>({
    queryKey: ['campaign-metrics', periodo, accountId],
    queryFn: async () => {
      try {
        const res = await apiClient.get<any>(`/api/dispatch/metrics?periodo=${periodo}`);
        return (res as any).data ?? res;
      } catch {
        // Backend ainda implementando — retornar zeros
        return { total_enviadas: 0, taxa_entrega: 0, opt_outs: 0, campanhas_ativas: 0 };
      }
    },
    retry: false,
  });

  // TODO: backend pendente — filtros por source/triggerName ainda sendo implementados
  const { data: batches = [], isLoading: loadingBatches } = useQuery<CampaignBatch[]>({
    queryKey: ['campaign-batches', sourceFiltro, triggerFiltro, periodo, accountId],
    queryFn: async () => {
      try {
        const params: Record<string, string> = { periodo };
        if (sourceFiltro !== 'todas') params.source = sourceFiltro;
        if (triggerFiltro.trim()) params.trigger_name = triggerFiltro.trim();
        const res = await apiClient.get<any>(API_ENDPOINTS.PROSPECTING.BATCHES, { params });
        const data = (res as any).data ?? res;
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },
    retry: false,
  });

  const m = metrics ?? { total_enviadas: 0, taxa_entrega: 0, opt_outs: 0, campanhas_ativas: 0 };

  return (
    <div className="space-y-6">
      {/* Filtros */}
      <div className="flex flex-wrap gap-3 items-center">
        <Select value={periodo} onValueChange={v => setPeriodo(v as Periodo)}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7d">Últimos 7 dias</SelectItem>
            <SelectItem value="30d">Últimos 30 dias</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sourceFiltro} onValueChange={v => setSourceFiltro(v as SourceFiltro)}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Fonte" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todas">Todas as fontes</SelectItem>
            <SelectItem value="manual">Manual</SelectItem>
            <SelectItem value="manual_scheduled">Agendado</SelectItem>
            <SelectItem value="n8n">n8n</SelectItem>
            <SelectItem value="api">API</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2 flex-1 min-w-48">
          <Filter className="w-4 h-4 text-muted-foreground flex-shrink-0" />
          <Input
            placeholder="Filtrar por trigger name..."
            value={triggerFiltro}
            onChange={e => setTriggerFiltro(e.target.value)}
            className="h-9"
          />
        </div>
      </div>

      {/* Cards de métricas */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingMetrics ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{m.total_enviadas.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Send className="w-3 h-3" /> Total enviadas
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingMetrics ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-green-600">{m.taxa_entrega.toFixed(1)}%</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Taxa de entrega
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingMetrics ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-destructive">{m.opt_outs}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <UserMinus className="w-3 h-3" /> Opt-outs gerados
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingMetrics ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-blue-600">{m.campanhas_ativas}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Zap className="w-3 h-3" /> Campanhas ativas
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabela de campanhas */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico de campanhas</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingBatches ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : batches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Zap className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">Nenhuma campanha encontrada</p>
              <p className="text-xs mt-1 text-center">
                {sourceFiltro !== 'todas' || triggerFiltro
                  ? 'Tente ajustar os filtros'
                  : 'Backend ainda implementando os filtros de campanhas'}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Contatos</TableHead>
                  <TableHead>Fonte</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Agendado para</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Criado em</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.map(b => (
                  <TableRow key={b.id}>
                    <TableCell className="font-medium">
                      {b.keyword || 'Disparo manual'}
                      {b.location && <span className="text-muted-foreground ml-1">· {b.location}</span>}
                    </TableCell>
                    <TableCell>{b.total_contacts}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{getSourceLabel(b.source ?? 'manual')}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {b.trigger_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {b.scheduled_at
                        ? new Date(b.scheduled_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <Badge variant={getStatusVariant(b.status)}>{getStatusLabel(b.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {new Date(b.created_at ?? b.started_at).toLocaleDateString('pt-BR')}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
