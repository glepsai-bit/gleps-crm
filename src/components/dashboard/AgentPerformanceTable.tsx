import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface AgentData {
  agentName: string;
  atendimentosAssumidos: number;
  atendimentosResolvidos: number;
  tempoMedioResposta: string;
  taxaResolucao: number;
}

interface AgentPerformanceTableProps {
  data: AgentData[];
  isLoading?: boolean;
  selectedAgentName?: string | null;
  onAgentSelect?: (agentName: string | null) => void;
}

export function AgentPerformanceTable({
  data,
  isLoading = false,
  selectedAgentName = null,
  onAgentSelect,
}: AgentPerformanceTableProps) {
  const handleRowClick = (agentName: string) => {
    if (!onAgentSelect) return;
    // Toggle selection: if already selected, deselect
    onAgentSelect(selectedAgentName === agentName ? null : agentName);
  };
  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {[...Array(5)].map((_, i) => (
              <div key={i} className="flex items-center gap-4">
                <Skeleton className="h-10 w-10 rounded-full" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  const getResolutionColor = (rate: number) => {
    if (rate >= 90) return 'bg-success/10 text-success';
    if (rate >= 70) return 'bg-warning/10 text-warning';
    return 'bg-destructive/10 text-destructive';
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Performance por Agente
          </CardTitle>
          {selectedAgentName && onAgentSelect && (
            <button
              onClick={() => onAgentSelect(null)}
              className="text-xs text-primary hover:text-primary/80 font-medium transition-colors flex items-center gap-1"
            >
              ✕ Limpar filtro
            </button>
          )}
        </div>
        {selectedAgentName && (
          <p className="text-xs text-primary mt-1">
            Clique na linha selecionada para remover o filtro
          </p>
        )}
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table className="min-w-[520px]">
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableHead className="font-semibold min-w-[140px]">Agente</TableHead>
                <TableHead className="text-center font-semibold min-w-[70px]">Assumidos</TableHead>
                <TableHead className="text-center font-semibold min-w-[70px]">Resolvidos</TableHead>
                <TableHead className="text-center font-semibold min-w-[80px] hidden sm:table-cell">Tempo Médio</TableHead>
                <TableHead className="text-center font-semibold min-w-[80px]">Taxa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    Nenhum dado de agente disponível
                  </TableCell>
                </TableRow>
              ) : (
                data.map((agent, index) => {
                const isSelected = selectedAgentName === agent.agentName;
                return (
                  <TableRow 
                    key={index} 
                    onClick={() => handleRowClick(agent.agentName)}
                    className={cn(
                      "transition-colors cursor-pointer",
                      isSelected 
                        ? "bg-primary/20 hover:bg-primary/25 border-l-2 border-l-primary" 
                        : "hover:bg-primary/5"
                    )}
                  >
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <Avatar className="h-8 w-8">
                          <AvatarFallback className={cn(
                            "text-xs",
                            isSelected ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary"
                          )}>
                            {getInitials(agent.agentName)}
                          </AvatarFallback>
                        </Avatar>
                        <span className="font-medium">{agent.agentName}</span>
                        {isSelected && (
                          <span className="text-xs text-primary font-medium">(Filtrado)</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-center font-medium">
                      {agent.atendimentosAssumidos}
                    </TableCell>
                    <TableCell className="text-center font-medium">
                      {agent.atendimentosResolvidos}
                    </TableCell>
                    <TableCell className="text-center text-muted-foreground hidden sm:table-cell">
                      {agent.tempoMedioResposta}
                    </TableCell>
                    <TableCell className="text-center">
                      <Badge
                        variant="secondary"
                        className={cn(getResolutionColor(agent.taxaResolucao))}
                      >
                        {agent.taxaResolucao}%
                      </Badge>
                    </TableCell>
                  </TableRow>
                );
              })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
