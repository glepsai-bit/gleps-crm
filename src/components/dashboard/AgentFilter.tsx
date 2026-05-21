import { useAuth, useRoleAccess } from '@/contexts/AuthContext';
import { mockUsers } from '@/data/mockData';
import { User as UserIcon } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMemo } from 'react';

interface AgentFilterProps {
  value: string;
  onChange: (value: string) => void;
}

export function AgentFilter({ value, onChange }: AgentFilterProps) {
  const { user, account } = useAuth();
  const { isAdmin } = useRoleAccess();

  // Get agents from the same account
  const accountAgents = useMemo(() => {
    if (!account?.id) return [];
    return mockUsers.filter(
      (u) => u.account_id === account.id && u.status === 'active'
    );
  }, [account?.id]);

  // Only show for admins, not super_admins or agents
  if (!isAdmin || user?.role !== 'admin') {
    return null;
  }

  if (accountAgents.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-2">
      <UserIcon className="w-4 h-4 text-muted-foreground" />
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="w-[180px] h-8">
          <SelectValue placeholder="Todos os usuários" />
        </SelectTrigger>
        <SelectContent className="bg-popover border border-border z-50">
          <SelectItem value="all">Todos os usuários</SelectItem>
          {accountAgents.map((agent) => (
            <SelectItem key={agent.id} value={agent.id}>
              <div className="flex items-center gap-2">
                <span
                  className={`w-2 h-2 rounded-full ${
                    agent.role === 'admin' ? 'bg-blue-500' : 'bg-green-500'
                  }`}
                />
                {agent.nome}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
