import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, Edit2, Trash2, FileText, Loader2, Eye, Sparkles } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { emailService, type EmailTemplate } from '@/services/email.service';
import EmailPreviewDialog from '@/components/email/EmailPreviewDialog';
import EmailRichEditor from '@/components/email/EmailRichEditor';
import EmailAIChat from '@/components/email/EmailAIChat';

const CATEGORIES = [
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'follow-up', label: 'Follow-up' },
  { value: 'reengajamento', label: 'Reengajamento' },
  { value: 'promocional', label: 'Promocional' },
  { value: 'informativo', label: 'Informativo' },
  { value: 'outro', label: 'Outro' },
];

export default function EmailTemplatesTab() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [previewTemplate, setPreviewTemplate] = useState<EmailTemplate | null>(null);
  const [showAI, setShowAI] = useState(false);
  const [form, setForm] = useState({ name: '', subject: '', bodyHtml: '', bodyText: '', category: '' });

  useEffect(() => { loadTemplates(); }, []);

  const loadTemplates = async () => {
    setLoading(true);
    try {
      const data = await emailService.listTemplates();
      setTemplates(data);
    } catch (err) {
      console.error('Erro ao carregar templates:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    try {
      if (editing) {
        const updated = await emailService.updateTemplate(editing.id, form);
        setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
        toast.success('Template atualizado!');
      } else {
        const created = await emailService.createTemplate(form);
        setTemplates(prev => [created, ...prev]);
        toast.success('Template criado!');
      }
      closeDialog();
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao salvar template');
    }
  };

  const handleDelete = async () => {
    if (!deleteId) return;
    try {
      await emailService.deleteTemplate(deleteId);
      setTemplates(prev => prev.filter(t => t.id !== deleteId));
      setDeleteId(null);
      toast.success('Template excluído!');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao excluir template');
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', subject: '', bodyHtml: '', bodyText: '', category: '' });
    setShowAI(false);
    setShowDialog(true);
  };

  const openEdit = (t: EmailTemplate) => {
    setEditing(t);
    setForm({
      name: t.name,
      subject: t.subject,
      bodyHtml: t.body_html,
      bodyText: t.body_text || '',
      category: t.category || '',
    });
    setShowAI(false);
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditing(null);
    setShowAI(false);
    setForm({ name: '', subject: '', bodyHtml: '', bodyText: '', category: '' });
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Modelos reutilizáveis de e-mail para suas cadências</p>
        <Button onClick={openCreate} size="sm">
          <Plus className="w-4 h-4 mr-2" />
          Novo Template
        </Button>
      </div>

      {templates.length === 0 ? (
        <Card className="card-gradient border-border/50">
          <CardContent className="py-12 text-center">
            <FileText className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="font-medium text-muted-foreground">Nenhum template criado</p>
            <p className="text-sm text-muted-foreground mt-1">Crie templates reutilizáveis para acelerar suas cadências.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid md:grid-cols-2 gap-4">
          {templates.map(t => (
            <Card key={t.id} className="card-gradient border-border/50 hover:border-primary/30 transition-colors">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-medium truncate">{t.name}</CardTitle>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setPreviewTemplate(t)} title="Preview">
                      <Eye className="w-3 h-3" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(t)}>
                      <Edit2 className="w-3 h-3" />
                    </Button>
                    <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDeleteId(t.id)}>
                      <Trash2 className="w-3 h-3 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-2">
                <p className="text-xs text-muted-foreground truncate">Assunto: {t.subject}</p>
                {t.category && (
                  <Badge variant="outline" className="text-[10px]">{CATEGORIES.find(c => c.value === t.category)?.label || t.category}</Badge>
                )}
                <p className="text-xs text-muted-foreground">
                  Criado em {new Date(t.created_at).toLocaleDateString('pt-BR')}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit Dialog with Rich Editor + AI */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className={`${showAI ? 'max-w-5xl' : 'max-w-2xl'} max-h-[90vh] overflow-hidden flex flex-col`}>
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>{editing ? 'Editar Template' : 'Novo Template'}</span>
              <Button
                variant={showAI ? 'default' : 'outline'}
                size="sm"
                className="text-xs"
                onClick={() => setShowAI(!showAI)}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1" />
                {showAI ? 'Fechar IA' : 'Gerar com IA'}
              </Button>
            </DialogTitle>
          </DialogHeader>

          <div className={`flex-1 min-h-0 overflow-y-auto ${showAI ? 'grid grid-cols-[1fr_320px] gap-0' : ''}`}>
            {/* Form */}
            <div className={`space-y-4 ${showAI ? 'pr-4 overflow-y-auto' : ''}`}>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">Nome</label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Ex: Follow-up Onboarding"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Categoria</label>
                  <Select value={form.category} onValueChange={(v) => setForm(prev => ({ ...prev, category: v }))}>
                    <SelectTrigger>
                      <SelectValue placeholder="Selecione" />
                    </SelectTrigger>
                    <SelectContent>
                      {CATEGORIES.map(c => (
                        <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <label className="text-sm font-medium">Assunto</label>
                <Input
                  value={form.subject}
                  onChange={(e) => setForm(prev => ({ ...prev, subject: e.target.value }))}
                  placeholder="Assunto do e-mail"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Corpo do e-mail</label>
                <EmailRichEditor
                  value={form.bodyHtml}
                  onChange={(html) => setForm(prev => ({ ...prev, bodyHtml: html }))}
                  placeholder="Comece a escrever o corpo do e-mail..."
                  minHeight="250px"
                />
              </div>
            </div>

            {/* AI Chat Panel */}
            {showAI && (
              <EmailAIChat
                onApply={(email) => {
                  setForm(prev => ({
                    ...prev,
                    subject: email.subject || prev.subject,
                    bodyHtml: email.bodyHtml,
                    bodyText: email.bodyText,
                  }));
                  toast.info('Conteúdo da IA aplicado ao template!');
                }}
                onClose={() => setShowAI(false)}
                context={{
                  currentSubject: form.subject,
                  currentBodyHtml: form.bodyHtml,
                }}
              />
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeDialog}>Cancelar</Button>
            <Button onClick={handleSave} disabled={!form.name.trim() || !form.subject.trim() || !form.bodyHtml.trim()}>
              {editing ? 'Salvar' : 'Criar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir template</AlertDialogTitle>
            <AlertDialogDescription>
              Tem certeza que deseja excluir este template? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Email Preview Dialog */}
      <EmailPreviewDialog
        open={!!previewTemplate}
        onOpenChange={(open) => !open && setPreviewTemplate(null)}
        subject={previewTemplate?.subject || ''}
        bodyHtml={previewTemplate?.body_html || ''}
        bodyText={previewTemplate?.body_text || undefined}
      />
    </div>
  );
}
