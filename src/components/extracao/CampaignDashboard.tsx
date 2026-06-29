import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { Send, CheckCircle2, XCircle, Zap, Filter } from 'lucide-react';

interface CampaignBatch {
  id: string;
  keyword: string | null;
  location: string | null;
  totalContacts: number;
  sentCount: number;
  failedCount: number;
  status: string;
  source: string;
  triggerName: string | null;
  scheduledAt: string | null;
  started_at: string;
  created_at: string;
}

/**
 * Métricas agregadas de campanhas — quando o endpoint
 * `/api/dispatch/metrics` for implementado, este tipo será o contrato
 * consumido pelo dashboard (hoje computamos localmente a partir dos batches).
 */
interface CampaignMetrics {
  totalEnviadas: number;
  totalFalhas: number;
  taxaEntrega: number;
  campanhasAtivas: number;
}

/** Resposta esperada do GET /api/dispatch/batches. */
interface BatchesResponse {
  data?: CampaignBatch[];
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

  // TODO: backend pendente — filtros por source/triggerName ainda sendo implementados
  const { data: batches = [], isLoading: loadingBatches } = useQuery<CampaignBatch[]>({
    queryKey: ['campaign-batches', sourceFiltro, triggerFiltro, periodo, accountId],
    queryFn: async () => {
      try {
        const params: Record<string, string> = { periodo };
        if (sourceFiltro !== 'todas') params.source = sourceFiltro;
        if (triggerFiltro.trim()) params.trigger_name = triggerFiltro.trim();
        const res = await apiClient.get<BatchesResponse | CampaignBatch[]>(
          API_ENDPOINTS.PROSPECTING.BATCHES_SCHEDULED,
          { params },
        );
        const data = Array.isArray(res) ? res : res?.data;
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    },
    retry: false,
  });

  // Métricas computadas localmente a partir dos batches carregados
  // (endpoint /api/dispatch/metrics ainda não existe no backend)
  const metrics = useMemo<CampaignMetrics>(() => {
    const totalEnviadas = batches.reduce((acc, b) => acc + (b.sentCount ?? 0), 0);
    const totalFalhas = batches.reduce((acc, b) => acc + (b.failedCount ?? 0), 0);
    const totalTentativas = totalEnviadas + totalFalhas;
    const taxaEntrega = totalTentativas > 0 ? (totalEnviadas / totalTentativas) * 100 : 0;
    const campanhasAtivas = batches.filter(
      b => b.status === 'running' || b.status === 'scheduled'
    ).length;
    return { totalEnviadas, totalFalhas, taxaEntrega, campanhasAtivas };
  }, [batches]);

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

      {/* Cards de métricas (computadas localmente a partir dos batches) */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingBatches ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{metrics.totalEnviadas.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Send className="w-3 h-3" /> Total enviadas
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingBatches ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-green-600">{metrics.taxaEntrega.toFixed(1)}%</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <CheckCircle2 className="w-3 h-3" /> Taxa de entrega
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingBatches ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-destructive">{metrics.totalFalhas.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <XCircle className="w-3 h-3" /> Falhas
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loadingBatches ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-blue-600">{metrics.campanhasAtivas}</div>
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
                {/* BUG-038: copy interno "backend ainda implementando" vazava
                    para producao. Trocado por mensagem neutra. */}
                {sourceFiltro !== 'todas' || triggerFiltro
                  ? 'Tente ajustar os filtros'
                  : 'Nenhum disparo no periodo selecionado'}
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
                    <TableCell>{b.totalContacts}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className="text-xs">{getSourceLabel(b.source ?? 'manual')}</Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {b.triggerName ?? '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {b.scheduledAt
                        ? new Date(b.scheduledAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
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
