import { useState, useCallback, useRef, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Upload, FileText, Send, AlertCircle, CheckCircle2, Save, Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useToast } from '@/hooks/use-toast';
import { parseCsv, detectColumns, buildLeadsFromCsv, type ParsedLeadRow } from './csvParser';
import { SaveAudienceDialog } from './SaveAudienceDialog';
import type { ExtractedLead } from './types';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Disparar agora com a lista importada */
  onConfirm: (leads: ExtractedLead[]) => void;
  /** Após salvar como público (recarregar lista) */
  onSaved?: () => void;
}

export function CsvImportDialog({ open, onOpenChange, onConfirm, onSaved }: Props) {
  const [saveOpen, setSaveOpen] = useState(false);
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [nameCol, setNameCol] = useState<string>('');
  const [phoneCol, setPhoneCol] = useState<string>('');
  const [parsed, setParsed] = useState<ParsedLeadRow[]>([]);

  const reset = useCallback(() => {
    setFileName(''); setHeaders([]); setRows([]);
    setNameCol(''); setPhoneCol(''); setParsed([]);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const handleFile = useCallback(async (file: File) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.csv')) {
      toast({ title: 'Formato inválido', description: 'Envie um arquivo .csv', variant: 'destructive' });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: 'Arquivo muito grande', description: 'Limite de 5MB', variant: 'destructive' });
      return;
    }
    const text = await file.text();
    const { headers: h, rows: r } = parseCsv(text);
    if (h.length === 0 || r.length === 0) {
      toast({ title: 'CSV vazio ou inválido', variant: 'destructive' });
      return;
    }
    const detected = detectColumns(h);
    setFileName(file.name);
    setHeaders(h);
    setRows(r);
    setNameCol(detected.name || h[0]);
    setPhoneCol(detected.phone || h[1] || h[0]);
  }, [toast]);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) handleFile(f);
  };

  useEffect(() => {
    if (!nameCol || !phoneCol || rows.length === 0) { setParsed([]); return; }
    setParsed(buildLeadsFromCsv(rows, nameCol, phoneCol));
  }, [nameCol, phoneCol, rows]);

  const valid = parsed.filter((p) => p.valid);
  const invalid = parsed.filter((p) => !p.valid);

  const buildLeads = (): ExtractedLead[] =>
    valid.map((p, idx) => ({
      id: `csv-${idx}-${p.telefone}`,
      nome: p.nome,
      cidade: '',
      endereco: '',
      telefone: p.telefone,
    }));

  const handleConfirm = () => {
    if (valid.length === 0) {
      toast({ title: 'Nenhum contato válido', variant: 'destructive' });
      return;
    }
    onConfirm(buildLeads());
    reset();
  };

  const handleOpenSave = () => {
    if (valid.length === 0) {
      toast({ title: 'Nenhum contato válido para salvar', variant: 'destructive' });
      return;
    }
    setSaveOpen(true);
  };

  const handleClose = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Importar contatos via planilha</DialogTitle>
          <DialogDescription>
            Envie um arquivo CSV com colunas de nome e telefone. Telefones serão normalizados (formato brasileiro).
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {!fileName ? (
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="w-full border-2 border-dashed border-border rounded-lg py-10 flex flex-col items-center justify-center hover:border-primary hover:bg-muted/30 transition"
            >
              <Upload className="w-8 h-8 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Clique para enviar um CSV</p>
              <p className="text-xs text-muted-foreground mt-1">
                Suporta delimitadores , ; ou tab · até 5MB
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={onFileChange}
              />
            </button>
          ) : (
            <>
              <div className="flex items-center justify-between p-3 border rounded-md bg-muted/30">
                <div className="flex items-center gap-2 text-sm">
                  <FileText className="w-4 h-4 text-primary" />
                  <span className="font-medium">{fileName}</span>
                  <Badge variant="secondary">{rows.length} linhas</Badge>
                </div>
                <Button variant="ghost" size="sm" onClick={reset}>Trocar</Button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label>Coluna do nome</Label>
                  <Select
                    value={nameCol}
                    onValueChange={(v) => { setNameCol(v); setParsed([]); }}
                  >
                    <SelectTrigger className="focus:ring-1 focus:ring-offset-0 focus-visible:ring-1 focus-visible:ring-offset-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Coluna do telefone</Label>
                  <Select
                    value={phoneCol}
                    onValueChange={(v) => { setPhoneCol(v); setParsed([]); }}
                  >
                    <SelectTrigger className="focus:ring-1 focus:ring-offset-0 focus-visible:ring-1 focus-visible:ring-offset-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {headers.map((h) => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {parsed.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-sm flex-wrap">
                    <CheckCircle2 className="w-4 h-4 text-primary" />
                    <span><strong>{valid.length}</strong> válidos</span>
                    {invalid.length > 0 && (
                      <>
                        <AlertCircle className="w-4 h-4 text-destructive ml-3" />
                        <span><strong>{invalid.length}</strong> inválidos (serão ignorados)</span>
                      </>
                    )}
                    <TooltipProvider delayDuration={150}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button type="button" className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                            <Info className="w-3.5 h-3.5" /> Regra de validação
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-xs text-xs">
                          <p className="font-medium mb-1">Telefone válido (Brasil):</p>
                          <ul className="list-disc pl-4 space-y-0.5">
                            <li>Apenas dígitos são considerados</li>
                            <li>Se vier sem DDI, prefixamos <code>55</code></li>
                            <li>Resultado: <code>+55</code> + DDD (2) + número (8 ou 9)</li>
                            <li>Total: 12 ou 13 dígitos após o <code>+</code></li>
                          </ul>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </div>
                  <div className="max-h-48 overflow-y-auto border rounded-md text-xs">
                    <table className="w-full">
                      <thead className="sticky top-0 bg-muted">
                        <tr>
                          <th className="text-left px-3 py-2">Nome</th>
                          <th className="text-left px-3 py-2">Telefone</th>
                          <th className="text-left px-3 py-2 w-20">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {parsed.slice(0, 50).map((p, i) => (
                          <tr key={i} className="border-t">
                            <td className="px-3 py-1.5 truncate max-w-[200px]">{p.nome}</td>
                            <td className="px-3 py-1.5 font-mono">{p.telefone}</td>
                            <td className="px-3 py-1.5">
                              {p.valid ? (
                                <Badge variant="outline">OK</Badge>
                              ) : (
                                <Badge variant="destructive" className="text-[10px]">{p.reason}</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {parsed.length > 50 && (
                      <p className="text-center py-2 text-muted-foreground">
                        ...e mais {parsed.length - 50} linhas
                      </p>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 flex-col sm:flex-row">
          <Button variant="outline" onClick={() => handleClose(false)} className="sm:mr-auto">
            Cancelar
          </Button>
          <Button variant="outline" onClick={handleOpenSave} disabled={valid.length === 0}>
            <Save className="w-4 h-4 mr-2" />
            Salvar como público
          </Button>
          <Button onClick={handleConfirm} disabled={valid.length === 0}>
            <Send className="w-4 h-4 mr-2" />
            Disparar agora ({valid.length})
          </Button>
        </DialogFooter>
      </DialogContent>

      <SaveAudienceDialog
        open={saveOpen}
        onOpenChange={setSaveOpen}
        leads={buildLeads()}
        defaultDescription={fileName ? `Importado de ${fileName}` : undefined}
        onSaved={() => {
          setSaveOpen(false);
          onSaved?.();
          reset();
          onOpenChange(false);
        }}
      />
    </Dialog>
  );
}
