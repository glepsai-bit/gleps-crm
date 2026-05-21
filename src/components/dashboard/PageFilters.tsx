import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { AgentFilter } from './AgentFilter';
import { useAuth, useRoleAccess } from '@/contexts/AuthContext';

interface PageFiltersProps {
  onAgentChange?: (agentId: string) => void;
  children?: React.ReactNode;
}

/**
 * Componente de filtros para páginas que suportam filtragem por agente.
 * O filtro de agente só aparece para usuários do tipo Admin.
 * Não deve ser usado no Dashboard de Atendimento (dados do Chatwoot são gerais).
 */
export function PageFilters({ onAgentChange, children }: PageFiltersProps) {
  const [selectedAgent, setSelectedAgent] = useState('all');
  const { user } = useAuth();
  const { isAdmin } = useRoleAccess();

  const showAgentFilter = isAdmin && user?.role === 'admin';

  const handleAgentChange = (value: string) => {
    setSelectedAgent(value);
    onAgentChange?.(value);
  };

  if (!showAgentFilter && !children) {
    return null;
  }

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          {children}
          {showAgentFilter && (
            <>
              {children && <div className="h-6 w-px bg-border" />}
              <AgentFilter value={selectedAgent} onChange={handleAgentChange} />
            </>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
