/**
 * T-022 — Dashboard de Tipos de Disparo.
 *
 * Consome `GET /api/prospecting/batches/aggregate` para devolver, dentro do
 * período selecionado, contagens agregadas por:
 *   - campaign_type (default — vem de metadata->>'campaign_type')
 *   - source (manual / n8n / api / integration / manual_scheduled)
 *   - trigger_name (string livre por integração)
 *
 * Layout:
 *   - Filtros: DateRange (fromDate / toDate) + Select groupBy.
 *   - Cards totalizadores no topo (disparos, enviados, falhas, taxa).
 *   - Tabela ordenada por disparos DESC.
 *   - Conv. / Exportar CSV: V2 (placeholder na coluna).
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { BarChart3, Calendar as CalendarIcon, Download, Layers, Send, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  prospectingBackendService,
  type AggregateRow,
} from '@/services/prospecting.backend.service';
import { getCampaignTypeMeta, getSourceMeta } from './campaignTypeLookup';

type GroupBy = 'campaign_type' | 'source' | 'trigger_name';

interface Props {
  accountId: string;
}

function isoNDaysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function renderRowKey(groupBy: GroupBy, row: AggregateRow) {
  const rawKey = row.key ?? '—';
  if (groupBy === 'campaign_type') {
    const meta = getCampaignTypeMeta(rawKey);
    return (
      <span className="inline-flex items-center gap-1.5">
        <span>{meta.icon}</span>
        <span className="font-medium">{meta.label}</span>
        {meta.label !== rawKey && (
          <span className="text-[10px] text-muted-foreground font-mono">{rawKey}</span>
        )}
      </span>
    );
  }
  if (groupBy === 'source') {
    const meta = getSourceMeta(rawKey);
    return (
      <Badge variant={meta.variant} className={cn('text-xs', meta.badgeClass)}>
        {meta.label}
      </Badge>
    );
  }
  // trigger_name
  return (
    <span className="font-mono text-xs">{rawKey === '—' ? '—' : rawKey}</span>
  );
}

export function DispatchTypeDashboard({ accountId }: Props) {
  const [fromDate, setFromDate] = useState<string>(isoNDaysAgo(30));
  const [toDate, setToDate] = useState<string>(todayIso());
  const [groupBy, setGroupBy] = useState<GroupBy>('campaign_type');

  const aggregateQuery = useQuery<AggregateRow[]>({
    queryKey: ['prospecting-aggregate', fromDate, toDate, groupBy, accountId],
    queryFn: () =>
      prospectingBackendService.getAggregate({
        fromDate,
        toDate: toDate ? `${toDate}T23:59:59.999Z` : undefined,
        groupBy,
      }),
    enabled: !!accountId,
    retry: false,
    staleTime: 30_000,
  });

  const rows = aggregateQuery.data ?? [];
  const loading = aggregateQuery.isLoading;

  const totals = useMemo(() => {
    const totalBatches = rows.reduce((acc, r) => acc + r.batchesCount, 0);
    const totalSent = rows.reduce((acc, r) => acc + r.totalSent, 0);
    const totalFailed = rows.reduce((acc, r) => acc + r.totalFailed, 0);
    const totalTry = totalSent + totalFailed;
    const deliveryRate = totalTry > 0 ? (totalSent / totalTry) * 100 : 0;
    return { totalBatches, totalSent, totalFailed, deliveryRate };
  }, [rows]);

  const setPreset = (days: number) => {
    setFromDate(isoNDaysAgo(days));
    setToDate(todayIso());
  };

  const groupByLabel: Record<GroupBy, string> = {
    campaign_type: 'Tipo de campanha',
    source: 'Origem',
    trigger_name: 'Trigger',
  };

  return (
    <div className="space-y-4">
      {/* Filtros */}
      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Agrupar por</Label>
              <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
                <SelectTrigger className="h-9 w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="campaign_type">Tipo de campanha</SelectItem>
                  <SelectItem value="source">Origem (source)</SelectItem>
                  <SelectItem value="trigger_name">Trigger name</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">De</Label>
              <Input
                type="date"
                className="h-9 w-[150px]"
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Até</Label>
              <Input
                type="date"
                className="h-9 w-[150px]"
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1">
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setPreset(7)}>
                <CalendarIcon className="w-3 h-3 mr-1" /> 7 dias
              </Button>
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setPreset(30)}>
                <CalendarIcon className="w-3 h-3 mr-1" /> 30 dias
              </Button>
              <Button variant="outline" size="sm" className="h-9 text-xs" onClick={() => setPreset(90)}>
                <CalendarIcon className="w-3 h-3 mr-1" /> 90 dias
              </Button>
            </div>
            <div className="ml-auto">
              {/* V2 — placeholder de exportação */}
              <Button variant="outline" size="sm" className="h-9 text-xs" disabled title="Disponível em breve">
                <Download className="w-3.5 h-3.5 mr-1" /> Exportar CSV
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Totais agregados */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card>
          <CardContent className="pt-5 pb-4">
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{totals.totalBatches.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Layers className="w-3 h-3" /> Disparos
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-green-600">{totals.totalSent.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <Send className="w-3 h-3" /> Enviadas
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-destructive">{totals.totalFailed.toLocaleString('pt-BR')}</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <XCircle className="w-3 h-3" /> Falhas
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5 pb-4">
            {loading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold text-blue-600">{totals.deliveryRate.toFixed(1)}%</div>
            )}
            <p className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
              <BarChart3 className="w-3 h-3" /> Taxa de entrega
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Tabela */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Agregação por {groupByLabel[groupBy]}</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <BarChart3 className="w-10 h-10 mb-3 opacity-30" />
              <p className="text-sm font-medium">Nenhum dado no período selecionado</p>
              <p className="text-xs mt-1">Ajuste o intervalo de datas para incluir disparos.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{groupByLabel[groupBy]}</TableHead>
                  <TableHead className="text-right">Disparos</TableHead>
                  <TableHead className="text-right">Enviados</TableHead>
                  <TableHead className="text-right">Falhas</TableHead>
                  <TableHead className="text-right">Média/disparo</TableHead>
                  <TableHead className="text-right text-muted-foreground" title="Disponível em breve">
                    Conv.
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, idx) => (
                  <TableRow key={`${row.key ?? 'null'}-${idx}`}>
                    <TableCell>{renderRowKey(groupBy, row)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {row.batchesCount.toLocaleString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right text-green-600">
                      {row.totalSent.toLocaleString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right text-destructive">
                      {row.totalFailed.toLocaleString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground">
                      {row.avgSentPerBatch.toLocaleString('pt-BR')}
                    </TableCell>
                    <TableCell className="text-right text-muted-foreground text-xs">N/A</TableCell>
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

export default DispatchTypeDashboard;
