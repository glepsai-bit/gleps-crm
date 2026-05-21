import { useMemo } from 'react';
import { useTagContext } from '@/contexts/TagContext';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Plus, Minus, Zap, User, Bot, Globe } from 'lucide-react';
import { cn } from '@/lib/utils';

interface TagHistoryListProps {
  contactId: string;
  maxItems?: number;
}

export function TagHistoryList({ contactId, maxItems = 10 }: TagHistoryListProps) {
  const { getContactTagHistory, getTagById } = useTagContext();

  const history = useMemo(() => {
    const items = getContactTagHistory(contactId);
    return maxItems ? items.slice(0, maxItems) : items;
  }, [contactId, getContactTagHistory, maxItems]);

  if (history.length === 0) {
    return (
      <div className="text-center py-6 text-sm text-muted-foreground">
        Nenhum histórico de tags disponível
      </div>
    );
  }

  const getActionIcon = (action: string) => {
    switch (action) {
      case 'added':
        return <Plus className="w-3 h-3" />;
      case 'removed':
        return <Minus className="w-3 h-3" />;
      case 'stage_created':
        return <Zap className="w-3 h-3" />;
      default:
        return null;
    }
  };

  const getActionColor = (action: string) => {
    switch (action) {
      case 'added':
        return 'bg-green-500/10 text-green-500 border-green-500/30';
      case 'removed':
        return 'bg-red-500/10 text-red-500 border-red-500/30';
      case 'stage_created':
        return 'bg-blue-500/10 text-blue-500 border-blue-500/30';
      default:
        return 'bg-muted';
    }
  };

  const getSourceIcon = (source: string) => {
    switch (source) {
      case 'kanban':
        return <User className="w-3 h-3" />;
      case 'chatwoot':
        return <Globe className="w-3 h-3" />;
      case 'system':
        return <Bot className="w-3 h-3" />;
      default:
        return null;
    }
  };

  const getSourceLabel = (source: string) => {
    switch (source) {
      case 'kanban':
        return 'Kanban';
      case 'chatwoot':
        return 'Chatwoot';
      case 'system':
        return 'Sistema';
      default:
        return source;
    }
  };

  return (
    <ScrollArea className="h-64">
      <div className="space-y-2 pr-3">
        {history.map((item) => {
          const tag = getTagById(item.tag_id);
          return (
            <div
              key={item.id}
              className="flex items-start gap-3 p-2 rounded-lg bg-muted/30 text-sm"
            >
              {/* Action Icon */}
              <div className={cn('p-1.5 rounded border', getActionColor(item.action))}>
                {getActionIcon(item.action)}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium">
                    {item.action === 'added' && 'Tag adicionada'}
                    {item.action === 'removed' && 'Tag removida'}
                    {item.action === 'tag_created' && 'Etapa criada'}
                  </span>
                  {tag && (
                    <Badge
                      variant="outline"
                      className="text-xs"
                      style={{
                        borderColor: tag.color,
                        color: tag.color,
                        backgroundColor: `${tag.color}10`,
                      }}
                    >
                      {tag.name}
                    </Badge>
                  )}
                </div>

                {item.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5">{item.reason}</p>
                )}

                <div className="flex items-center gap-3 mt-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1">
                    {getSourceIcon(item.source)}
                    {getSourceLabel(item.source)}
                  </span>
                  <span>
                    {format(new Date(item.created_at), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}
