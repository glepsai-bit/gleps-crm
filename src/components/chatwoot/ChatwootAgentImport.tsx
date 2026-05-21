import { useState } from 'react';
import { ChatwootAgent } from '@/types/crm';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { 
  User, 
  Shield, 
  CheckCircle2, 
  XCircle,
  Users,
  ArrowRight
} from 'lucide-react';

interface ChatwootAgentImportProps {
  agents: ChatwootAgent[];
  selectedAgentIds: number[];
  onSelectionChange: (ids: number[]) => void;
  onProceed: () => void;
  onSkip: () => void;
}

export function ChatwootAgentImport({
  agents,
  selectedAgentIds,
  onSelectionChange,
  onProceed,
  onSkip,
}: ChatwootAgentImportProps) {
  const toggleAgent = (agentId: number) => {
    if (selectedAgentIds.includes(agentId)) {
      onSelectionChange(selectedAgentIds.filter(id => id !== agentId));
    } else {
      onSelectionChange([...selectedAgentIds, agentId]);
    }
  };

  const selectAll = () => {
    onSelectionChange(agents.map(a => a.id));
  };

  const clearSelection = () => {
    onSelectionChange([]);
  };

  const getRoleBadge = (role: ChatwootAgent['role']) => {
    if (role === 'administrator') {
      return (
        <Badge variant="secondary" className="gap-1">
          <Shield className="w-3 h-3" />
          Administrador
        </Badge>
      );
    }
    return (
      <Badge variant="outline" className="gap-1">
        <User className="w-3 h-3" />
        Agente
      </Badge>
    );
  };

  const getStatusIndicator = (status?: ChatwootAgent['availability_status']) => {
    switch (status) {
      case 'online':
        return <span className="w-2 h-2 rounded-full bg-emerald-500" title="Online" />;
      case 'busy':
        return <span className="w-2 h-2 rounded-full bg-amber-500" title="Ocupado" />;
      case 'offline':
      default:
        return <span className="w-2 h-2 rounded-full bg-muted-foreground/50" title="Offline" />;
    }
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="w-4 h-4" />
          <span>{agents.length} agentes encontrados</span>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={selectAll}>
            Selecionar todos
          </Button>
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Limpar
          </Button>
        </div>
      </div>

      {/* Agent List */}
      <ScrollArea className="h-[240px] rounded-md border">
        <div className="p-2 space-y-1">
          {agents.map((agent) => {
            const isSelected = selectedAgentIds.includes(agent.id);
            return (
              <div
                key={agent.id}
                className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                  isSelected 
                    ? 'bg-primary/10 border border-primary/20' 
                    : 'hover:bg-muted/50 border border-transparent'
                }`}
                onClick={() => toggleAgent(agent.id)}
              >
                <Checkbox 
                  checked={isSelected} 
                  onCheckedChange={() => toggleAgent(agent.id)}
                />
                
                {/* Avatar placeholder */}
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
                  {agent.name.split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{agent.name}</span>
                    {getStatusIndicator(agent.availability_status)}
                  </div>
                  <span className="text-sm text-muted-foreground truncate block">
                    {agent.email}
                  </span>
                </div>

                {/* Role Badge */}
                {getRoleBadge(agent.role)}

                {/* Selection indicator */}
                {isSelected ? (
                  <CheckCircle2 className="w-5 h-5 text-primary shrink-0" />
                ) : (
                  <XCircle className="w-5 h-5 text-muted-foreground/30 shrink-0" />
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2 border-t">
        <span className="text-sm text-muted-foreground">
          {selectedAgentIds.length} agente(s) selecionado(s)
        </span>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onSkip}>
            Pular - Criar Sem Usuários
          </Button>
          <Button 
            onClick={onProceed} 
            disabled={selectedAgentIds.length === 0}
            className="gap-2"
          >
            Criar Conta e Importar
            <ArrowRight className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
