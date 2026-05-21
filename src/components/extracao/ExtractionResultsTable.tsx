import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Trash2, ExternalLink, Star, MapPin } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ExtractedLead } from './types';

interface Props {
  leads: ExtractedLead[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onSelectAll: () => void;
  onRemove: (id: string) => void;
}

export function ExtractionResultsTable({ leads, selectedIds, onToggleSelect, onSelectAll, onRemove }: Props) {
  const allSelected = leads.length > 0 && selectedIds.size === leads.length;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">Resultados ({leads.length} leads)</CardTitle>
          <span className="text-sm text-muted-foreground">{selectedIds.size} selecionados</span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-auto max-h-[500px]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">
                  <Checkbox checked={allSelected} onCheckedChange={onSelectAll} />
                </TableHead>
                <TableHead>Nome</TableHead>
                <TableHead>Cidade</TableHead>
                <TableHead>Telefone</TableHead>
                <TableHead>Avaliação</TableHead>
                <TableHead>Links</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {leads.map(lead => (
                <TableRow key={lead.id}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(lead.id)}
                      onCheckedChange={() => onToggleSelect(lead.id)}
                    />
                  </TableCell>
                  <TableCell>
                    <div>
                      <span className="font-medium">{lead.nome}</span>
                      {lead.endereco && (
                        <p className="text-xs text-muted-foreground truncate max-w-[200px]">{lead.endereco}</p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{lead.cidade}</TableCell>
                  <TableCell>
                    {lead.telefone ? (
                      <span className="font-mono text-sm">{lead.telefone}</span>
                    ) : (
                      <Badge variant="outline" className="text-xs">Sem telefone</Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    {lead.avaliacao ? (
                      <div className="flex items-center gap-1">
                        <Star className="w-3.5 h-3.5 text-yellow-500 fill-yellow-500" />
                        <span className="text-sm font-medium">{lead.avaliacao}</span>
                        {lead.total_avaliacoes && (
                          <span className="text-xs text-muted-foreground">({lead.total_avaliacoes})</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-muted-foreground text-xs">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      {lead.site && (
                        <a
                          href={lead.site.startsWith('http') ? lead.site : `https://${lead.site}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-0.5 text-xs"
                        >
                          <ExternalLink className="w-3 h-3" />
                          Site
                        </a>
                      )}
                      {lead.google_maps_url && (
                        <a
                          href={lead.google_maps_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline inline-flex items-center gap-0.5 text-xs ml-2"
                        >
                          <MapPin className="w-3 h-3" />
                          Maps
                        </a>
                      )}
                      {!lead.site && !lead.google_maps_url && (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => onRemove(lead.id)}>
                      <Trash2 className="w-4 h-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
