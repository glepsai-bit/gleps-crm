import { useState, useMemo } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { Eye, Send, Loader2, Monitor, Smartphone, Code } from 'lucide-react';
import { emailService } from '@/services/email.service';

interface EmailPreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}

export default function EmailPreviewDialog({
  open,
  onOpenChange,
  subject,
  bodyHtml,
  bodyText,
}: EmailPreviewDialogProps) {
  const [viewMode, setViewMode] = useState<'desktop' | 'mobile'>('desktop');
  const [activeTab, setActiveTab] = useState<'preview' | 'html' | 'test'>('preview');
  const [testEmail, setTestEmail] = useState('');
  const [sending, setSending] = useState(false);

  const iframeSrcDoc = useMemo(() => {
    const preview = bodyHtml
      .replace(/\{nome\}/g, 'João Silva')
      .replace(/\{email\}/g, 'joao@exemplo.com')
      .replace(/\{empresa\}/g, 'Empresa Exemplo');

    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;margin:0;padding:24px;color:#1a1a1a;background:#fff;font-size:14px;line-height:1.6}img{max-width:100%;height:auto}a{color:#EE3924}h1,h2,h3{margin:0 0 12px;color:#111}p{margin:0 0 16px}</style></head><body>${preview}</body></html>`;
  }, [bodyHtml]);

  const handleSendTest = async () => {
    if (!testEmail.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmail)) {
      toast.error('Digite um e-mail válido');
      return;
    }
    setSending(true);
    try {
      const settings = await emailService.getSettings();
      if (!settings.hasSendgridKey) {
        toast.error('Credenciais de envio não configuradas.');
        return;
      }
      const result = await emailService.testSendEmail(
        '__existing__',
        settings.sendgridFromEmail,
        settings.sendgridFromName || 'GoodLeads CRM',
        testEmail,
        { subject: `[TESTE] ${subject}`, html: bodyHtml, text: bodyText }
      );
      if (result.success) {
        toast.success(`E-mail de teste enviado para ${testEmail}!`);
      } else {
        toast.error(result.error || 'Erro ao enviar e-mail de teste');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao enviar e-mail de teste');
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye className="w-5 h-5" />
            Preview do E-mail
          </DialogTitle>
          <DialogDescription>
            Visualize como o e-mail será exibido e envie um teste
          </DialogDescription>
        </DialogHeader>

        {/* Subject line */}
        <div className="px-4 py-2.5 bg-muted/30 rounded-lg border border-border/50">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground font-medium">Assunto:</span>
            <span className="font-semibold text-foreground">{subject}</span>
          </div>
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="preview" className="flex items-center gap-2">
              <Eye className="w-4 h-4" />
              Preview
            </TabsTrigger>
            <TabsTrigger value="html" className="flex items-center gap-2">
              <Code className="w-4 h-4" />
              HTML
            </TabsTrigger>
            <TabsTrigger value="test" className="flex items-center gap-2">
              <Send className="w-4 h-4" />
              Envio de Teste
            </TabsTrigger>
          </TabsList>

          {/* Preview Tab */}
          <TabsContent value="preview" className="flex-1 flex flex-col min-h-0 mt-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="flex items-center bg-muted/30 rounded-lg p-0.5">
                <Button
                  variant={viewMode === 'desktop' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs px-3"
                  onClick={() => setViewMode('desktop')}
                >
                  <Monitor className="w-3.5 h-3.5 mr-1" /> Desktop
                </Button>
                <Button
                  variant={viewMode === 'mobile' ? 'default' : 'ghost'}
                  size="sm"
                  className="h-7 text-xs px-3"
                  onClick={() => setViewMode('mobile')}
                >
                  <Smartphone className="w-3.5 h-3.5 mr-1" /> Mobile
                </Button>
              </div>
              <Badge variant="secondary" className="text-[10px] ml-auto">
                Variáveis substituídas por dados de exemplo
              </Badge>
            </div>

            {/* Device Frame */}
            <div className="flex-1 flex justify-center bg-muted/20 rounded-lg p-4">
              <div className={`bg-white rounded-xl shadow-lg overflow-hidden border border-border transition-all ${
                viewMode === 'mobile' ? 'w-[375px]' : 'w-full max-w-[640px]'
              }`}>
                {/* Simulated email client header */}
                <div className="bg-muted/40 px-4 py-2 border-b border-border">
                  <div className="flex items-center gap-1.5 mb-2">
                    <div className="w-3 h-3 rounded-full bg-destructive/60" />
                    <div className="w-3 h-3 rounded-full bg-warning/60" />
                    <div className="w-3 h-3 rounded-full bg-success/60" />
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    <span className="font-medium">De:</span> GoodLeads &lt;noreply@empresa.com&gt;
                  </p>
                  <p className="text-xs font-medium text-foreground truncate">{subject}</p>
                </div>
                <iframe
                  title="Email Preview"
                  sandbox="allow-same-origin"
                  srcDoc={iframeSrcDoc}
                  className="w-full border-0"
                  style={{ minHeight: '300px', maxHeight: '380px' }}
                />
              </div>
            </div>
          </TabsContent>

          {/* HTML Tab */}
          <TabsContent value="html" className="flex-1 min-h-0 mt-4">
            <pre className="bg-muted/20 border border-border rounded-lg p-4 text-xs overflow-auto max-h-[400px] font-mono whitespace-pre-wrap text-foreground">
              {bodyHtml}
            </pre>
          </TabsContent>

          {/* Test Send Tab */}
          <TabsContent value="test" className="mt-4">
            <div className="space-y-4">
              <div className="p-5 bg-muted/20 rounded-lg border border-border/50">
                <p className="text-sm text-muted-foreground mb-4">
                  Envie este e-mail como teste para verificar a aparência e entrega.
                  <strong className="text-foreground"> Não afeta métricas</strong> da cadência.
                </p>
                <div className="flex gap-2">
                  <Input
                    type="email"
                    value={testEmail}
                    onChange={(e) => setTestEmail(e.target.value)}
                    placeholder="seu@email.com"
                    className="flex-1"
                  />
                  <Button onClick={handleSendTest} disabled={sending || !testEmail.trim()}>
                    {sending ? (
                      <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4 mr-2" />
                    )}
                    Enviar Teste
                  </Button>
                </div>
              </div>

              {bodyText && (
                <div>
                  <p className="text-sm font-medium mb-2">Versão texto (fallback):</p>
                  <pre className="bg-muted/20 border border-border rounded-lg p-3 text-xs overflow-auto max-h-[200px] whitespace-pre-wrap text-foreground">
                    {bodyText}
                  </pre>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Fechar</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
