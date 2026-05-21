import { useState } from 'react';
import { useTagContext } from '@/contexts/TagContext';
import { useAuth } from '@/contexts/AuthContext';
import { Tag } from '@/types/crm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Tags, Check, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

interface TagSelectorProps {
  contactId: string;
  trigger?: React.ReactNode;
}

export function TagSelector({ contactId, trigger }: TagSelectorProps) {
  const { user } = useAuth();
  const { 
    getLeadOperationalTags, 
    operationalTags,
    toggleOperationalTag,
    hasTag 
  } = useTagContext();
  const [open, setOpen] = useState(false);

  const currentTags = getLeadOperationalTags(contactId);
  const availableTags = operationalTags;

  const handleToggleTag = (tag: Tag) => {
    const result = toggleOperationalTag({
      contactId,
      tagId: tag.id,
      source: 'kanban',
      actorType: 'user',
      actorId: user?.id || null,
    });

    if (result.success) {
      toast.success(result.added ? `Tag "${tag.name}" adicionada` : `Tag "${tag.name}" removida`);
    } else {
      toast.error(result.error || 'Erro ao atualizar tag');
    }
  };

  const handleRemoveTag = (tag: Tag, e: React.MouseEvent) => {
    e.stopPropagation();
    handleToggleTag(tag);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {trigger || (
          <Button variant="outline" size="sm" className="gap-2">
            <Tags className="w-4 h-4" />
            Etiquetas
            {currentTags.length > 0 && (
              <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                {currentTags.length}
              </Badge>
            )}
          </Button>
        )}
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="p-3 border-b">
          <h4 className="font-medium text-sm">Etiquetas Operacionais</h4>
          <p className="text-xs text-muted-foreground mt-1">
            Tags para organização visual. Não afetam o estágio do funil.
          </p>
        </div>
        
        {/* Current Tags */}
        {currentTags.length > 0 && (
          <>
            <div className="p-3">
              <p className="text-xs text-muted-foreground mb-2">Aplicadas:</p>
              <div className="flex flex-wrap gap-1.5">
                {currentTags.map((tag) => (
                  <Badge
                    key={tag.id}
                    variant="secondary"
                    className="text-xs gap-1 pr-1"
                    style={{ 
                      backgroundColor: `${tag.color}20`,
                      color: tag.color,
                      borderColor: tag.color
                    }}
                  >
                    {tag.name}
                    <button
                      onClick={(e) => handleRemoveTag(tag, e)}
                      className="hover:bg-black/10 rounded p-0.5"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </Badge>
                ))}
              </div>
            </div>
            <Separator />
          </>
        )}

        {/* Available Tags */}
        <ScrollArea className="max-h-48">
          <div className="p-2">
            {availableTags.map((tag) => {
              const isApplied = hasTag(contactId, tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => handleToggleTag(tag)}
                  className={cn(
                    'w-full flex items-center justify-between px-3 py-2 rounded-md text-sm hover:bg-accent transition-colors',
                    isApplied && 'bg-accent'
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    <span>{tag.name}</span>
                  </div>
                  {isApplied && <Check className="w-4 h-4 text-primary" />}
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  );
}
