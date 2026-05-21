import { useState, useEffect, useCallback, useContext, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';
import {
  Plus, Edit2, Trash2, Loader2, FolderOpen, BarChart3, Send, Mail,
  Eye, MousePointer, AlertTriangle, ChevronRight, Clock, GitBranch,
  Zap, Inbox, MailOpen, RefreshCw, Users, FileText, Sparkles,
  MoreHorizontal, ArrowLeft
} from 'lucide-react';
import {
  emailService,
  type EmailCampaign,
  type EmailCadence,
  type EmailCadenceStep,
  type EmailCadenceRule,
  type EmailTemplate,
  type SendStats,
} from '@/services/email.service';
import { useBackend } from '@/config/backend.config';
import { AuthContext } from '@/contexts/AuthContext';
import EmailPreviewDialog from '@/components/email/EmailPreviewDialog';
import EmailRichEditor from '@/components/email/EmailRichEditor';
import EmailAIChat from '@/components/email/EmailAIChat';
import EmailTemplatesTab from '@/components/email/EmailTemplatesTab';
import EmailSendsTab from '@/components/email/EmailSendsTab';
import EmailInboxTab from '@/components/email/EmailInboxTab';
import StepRecipientsPanel from '@/components/email/StepRecipientsPanel';
import { apiClient } from '@/api/client';
import { API_ENDPOINTS } from '@/api/endpoints';

// Map low-level errors (HTTP 429, network, etc.) to clear user-facing messages
// so the UI never silently swallows a failed save.
function friendlyEmailError(err: any, fallback: string): string {
  const status = err?.status ?? err?.response?.status;
  const code = err?.code ?? err?.response?.data?.error?.code;
  if (status === 429 || code === 'RATE_LIMIT_EXCEEDED') {
    return 'O servidor recebeu muitas requisições simultâneas. Aguarde alguns segundos e tente novamente.';
  }
  if (status === 401 || status === 403) {
    return 'Sessão expirada ou sem permissão. Faça login novamente.';
  }
  return err?.message || fallback;
}

interface Audience {
  id: string;
  name: string;
  contact_count?: number;
}

interface CampaignFull extends EmailCampaign {
  audience_id?: string | null;
  audience?: Audience | null;
  stats?: SendStats & { enrollments: number };
  linkedCadences?: EmailCadence[];
}

export default function EmailCampaignsTab() {
  const auth = useContext(AuthContext);
  const accountId = auth?.account?.id || auth?.user?.account_id || '';
  const [searchParams, setSearchParams] = useSearchParams();
  const [campaigns, setCampaigns] = useState<CampaignFull[]>([]);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedCampaign, setSelectedCampaign] = useState<CampaignFull | null>(null);
  const [innerTab, setInnerTab] = useState('cadences');

  // Campaign Dialogs
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [editingCampaign, setEditingCampaign] = useState<EmailCampaign | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', audienceId: '' });

  // Cadence state
  const [selectedCadence, setSelectedCadence] = useState<EmailCadence | null>(null);
  const [showCadenceDialog, setShowCadenceDialog] = useState(false);
  const [editingCadence, setEditingCadence] = useState<EmailCadence | null>(null);
  const [cadenceForm, setCadenceForm] = useState({ name: '', description: '', sendAtTime: '09:00', startDate: new Date().toISOString().split('T')[0] });

  // Step state
  const [showStepDialog, setShowStepDialog] = useState(false);
  const [editingStep, setEditingStep] = useState<EmailCadenceStep | null>(null);
  const [stepForm, setStepForm] = useState<{ dayNumber: number; subject: string; bodyHtml: string; bodyText: string; templateId: string | null }>({ dayNumber: 1, subject: '', bodyHtml: '', bodyText: '', templateId: null });
  const [showStepAI, setShowStepAI] = useState(false);
  const [previewStep, setPreviewStep] = useState<EmailCadenceStep | null>(null);
  const [expandedStepId, setExpandedStepId] = useState<string | null>(null);

  // Quick template editor (opened from a step)
  const [editingTemplate, setEditingTemplate] = useState<EmailTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState({ name: '', subject: '', bodyHtml: '', bodyText: '' });
  const [savingTemplate, setSavingTemplate] = useState(false);

  // Rule state
  const [showRuleDialog, setShowRuleDialog] = useState(false);
  const [ruleForm, setRuleForm] = useState({ triggerEvent: 'opened', targetCadenceId: '', delayHours: 0, timeoutHours: 48 });

  // Templates
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);

  // Dispatch-now state
  const [dispatching, setDispatching] = useState(false);
  const [showDispatchConfirm, setShowDispatchConfirm] = useState(false);

  // Refs mirror URL params so loadData (which only depends on accountId)
  // can read the current selection without re-running on every selection change.
  const selectedCampaignIdRef = useRef<string | null>(searchParams.get('campaign'));
  const selectedCadenceIdRef = useRef<string | null>(searchParams.get('cadence'));

  // Sync URL → refs and component state when user selects a campaign/cadence
  const updateUrlSelection = useCallback((campaignId: string | null, cadenceId: string | null) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (campaignId) next.set('campaign', campaignId); else next.delete('campaign');
      if (cadenceId) next.set('cadence', cadenceId); else next.delete('cadence');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    // Only sync back to URL if we have a selection AND we aren't currently loading the list
    // This prevents the refresh from clearing the searchParams before they are processed by loadData
    if (!loading && selectedCampaign) {
      selectedCampaignIdRef.current = selectedCampaign.id;
      selectedCadenceIdRef.current = selectedCadence?.id || null;
      updateUrlSelection(selectedCampaign.id, selectedCadence?.id || null);
    }
  }, [selectedCampaign, selectedCadence, updateUrlSelection, loading]);

  const loadData = useCallback(async () => {
    // Marca apenas o primeiro carregamento como "loading" (skeleton).
    // Em refreshes subsequentes, mantemos a UI atual visível e apenas
    // atualizamos os dados quando chegarem — nunca piscamos para zero.
    setLoading(prev => (campaigns.length === 0 ? true : prev));
    try {
      const [campaignsData, cadencesData, templatesData] = await Promise.all([
        emailService.listCampaigns(),
        emailService.listCadences(),
        emailService.listTemplates().catch(() => []),
      ]);

      // Load audiences in both modes
      let audWithCounts: Audience[] = [];
      if (useBackend) {
        const res = await apiClient.get<any>(API_ENDPOINTS.EMAIL.AUDIENCES);
        const data = res?.data ?? res;
        audWithCounts = (Array.isArray(data) ? data : []).map((a: any) => ({
          id: a.id,
          name: a.name,
          contact_count: a.contact_count ?? a._count?.contacts ?? 0,
        }));
      } else {
        const { supabase } = await import('@/integrations/supabase/client');
        const { data: audData } = await supabase
          .from('email_audiences')
          .select('id, name')
          .eq('account_id', accountId);
        const audList: Audience[] = (audData || []);
        audWithCounts = await Promise.all(audList.map(async (a) => {
          const { count } = await supabase
            .from('email_audience_contacts')
            .select('*', { count: 'exact', head: true })
            .eq('audience_id', a.id);
          return { ...a, contact_count: count || 0 };
        }));
      }
      setAudiences(audWithCounts);

      const emptyStats = { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: 0 };

      // Preserva stats já conhecidos (do estado anterior) para evitar piscar para zero.
      // A próxima atualização (em paralelo) substitui pelos números frescos vindos do backend.
      const previousStatsById = new Map<string, any>();
      setCampaigns(prev => {
        prev.forEach(c => { if (c.stats) previousStatsById.set(c.id, c.stats); });
        return prev;
      });

      const enriched: CampaignFull[] = campaignsData.map((camp: any) => {
        const linked = cadencesData.filter((c: any) => c.campaign_id === camp.id);
        const audienceId = camp.audience_id ?? camp.audience?.id ?? null;
        const audience = audienceId ? audWithCounts.find(a => a.id === audienceId) || null : null;
        const previousStats = previousStatsById.get(camp.id);
        return {
          ...camp,
          audience_id: audienceId,
          linkedCadences: linked,
          audience,
          stats: previousStats ?? { ...emptyStats },
        };
      });

      setCampaigns(enriched);
      setTemplates(templatesData);

      const currentCampaignId = selectedCampaignIdRef.current;
      const currentCadenceId = selectedCadenceIdRef.current;
      const nextCampaign = (currentCampaignId && enriched.find(c => c.id === currentCampaignId)) || enriched[0] || null;

      setSelectedCampaign(nextCampaign);

      if (nextCampaign) {
        const nextCadence = (currentCadenceId && nextCampaign.linkedCadences?.find(c => c.id === currentCadenceId))
          || nextCampaign.linkedCadences?.[0]
          || null;
        setSelectedCadence(nextCadence);
      } else {
        setSelectedCadence(null);
      }

      // Carrega stats de TODAS as campanhas em paralelo, com pequeno escalonamento
      // para suavizar carga em listas grandes. Atualiza item por item conforme chegam,
      // garantindo que cada cartão receba seu número correto após F5.
      enriched.forEach((camp, idx) => {
        // Pequeno stagger evita disparar N requests no mesmo tick.
        setTimeout(() => {
          emailService.getCampaignStats(camp.id)
            .then((stats) => {
              setCampaigns(prev => prev.map(c => c.id === camp.id ? { ...c, stats: { ...stats } } : c));
              // Mantém a campanha selecionada sincronizada com o stats fresco
              setSelectedCampaign(prev => (prev && prev.id === camp.id) ? { ...prev, stats: { ...stats } } : prev);
            })
            .catch(() => { /* stats são não críticos — preservamos o último valor conhecido */ });
        }, idx * 80);
      });
    } catch (err: any) {
      console.error('Erro ao carregar campanhas:', err);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ==================== CAMPAIGN CRUD ====================
  const handleSaveCampaign = async () => {
    try {
      const payload = {
        name: form.name,
        description: form.description,
        audienceId: form.audienceId || null,
      };

      const emptyStats = { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: 0 };

      if (editingCampaign) {
        const updated: any = await emailService.updateCampaign(editingCampaign.id, payload);
        const audience = payload.audienceId ? audiences.find(a => a.id === payload.audienceId) || null : null;
        // Optimistic local update — avoid re-fetching the entire dashboard
        // (which used to fan out into N parallel requests and trip the limiter).
        setCampaigns(prev => prev.map(c => c.id === editingCampaign.id
          ? { ...c, ...updated, audience_id: payload.audienceId, audience }
          : c));
        if (selectedCampaign?.id === editingCampaign.id) {
          setSelectedCampaign(prev => prev ? { ...prev, ...updated, audience_id: payload.audienceId, audience } : prev);
        }
        toast.success('Campanha atualizada!');
      } else {
        const created: any = await emailService.createCampaign(payload);
        const audience = payload.audienceId ? audiences.find(a => a.id === payload.audienceId) || null : null;
        const enriched: CampaignFull = {
          ...created,
          audience_id: payload.audienceId,
          audience,
          linkedCadences: [],
          stats: { ...emptyStats },
        };
        setCampaigns(prev => [enriched, ...prev]);
        selectedCampaignIdRef.current = created.id;
        setSelectedCampaign(enriched);
        setSelectedCadence(null);
        toast.success('Campanha criada!');
      }
      setShowCreateDialog(false);
      setEditingCampaign(null);
      setForm({ name: '', description: '', audienceId: '' });
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao salvar campanha'));
    }
  };

  const handleDeleteCampaign = async () => {
    if (!deleteId) return;
    try {
      await emailService.deleteCampaign(deleteId);
      toast.success('Campanha excluída!');
      if (selectedCampaign?.id === deleteId) { setSelectedCampaign(null); setSelectedCadence(null); }
      setCampaigns(prev => prev.filter(c => c.id !== deleteId));
      setDeleteId(null);
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao excluir'));
    }
  };

  // ==================== CADENCE CRUD (inside campaign) ====================
  const handleSaveCadence = async () => {
    if (!selectedCampaign) return;
    try {
      if (editingCadence) {
        const updated = await emailService.updateCadence(editingCadence.id, cadenceForm);
        setSelectedCadence(updated);
        toast.success('Cadência atualizada!');
      } else {
        const created = await emailService.createCadence(cadenceForm);
        // Link to campaign
        await emailService.addCadenceToCampaign(selectedCampaign.id, created.id);
        selectedCampaignIdRef.current = selectedCampaign.id;
        selectedCadenceIdRef.current = created.id;
        setSelectedCadence({ ...created, campaign_id: selectedCampaign.id });
        toast.success('Cadência criada e vinculada!');
      }
      setShowCadenceDialog(false);
      setCadenceForm({ name: '', description: '', sendAtTime: '09:00', startDate: new Date().toISOString().split('T')[0] });
      setEditingCadence(null);
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao salvar cadência'));
    }
  };

  const handleDeleteCadence = async (id: string) => {
    try {
      await emailService.deleteCadence(id);
      if (selectedCadence?.id === id) setSelectedCadence(null);
      toast.success('Cadência excluída!');
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao excluir'));
    }
  };

  // ==================== STEP CRUD ====================
  const handleSaveStep = async () => {
    if (!selectedCadence) return;
    try {
      if (editingStep) {
        await emailService.updateStep(editingStep.id, stepForm);
        toast.success('Step atualizado!');
      } else {
        await emailService.createStep(selectedCadence.id, stepForm);
        toast.success('Step criado!');
      }
      setShowStepDialog(false);
      setStepForm({ dayNumber: 1, subject: '', bodyHtml: '', bodyText: '', templateId: null });
      setEditingStep(null);
      setShowStepAI(false);
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao salvar step'));
    }
  };

  const handleDeleteStep = async (stepId: string) => {
    try {
      await emailService.deleteStep(stepId);
      toast.success('Step excluído!');
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao excluir'));
    }
  };

  // ==================== RULES ====================
  const handleSaveRule = async () => {
    if (!selectedCadence || !ruleForm.targetCadenceId) return;
    try {
      await emailService.createRule(selectedCadence.id, ruleForm);
      toast.success('Regra criada!');
      setShowRuleDialog(false);
      setRuleForm({ triggerEvent: 'opened', targetCadenceId: '', delayHours: 0, timeoutHours: 48 });
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao criar regra'));
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    try {
      await emailService.deleteRule(ruleId);
      toast.success('Regra excluída!');
      await loadData();
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro'));
    }
  };

  const handleLoadTemplate = (templateId: string) => {
    const t = templates.find(t => t.id === templateId);
    if (t) {
      setStepForm(prev => ({ ...prev, subject: t.subject, bodyHtml: t.body_html, bodyText: t.body_text || '', templateId: t.id }));
      toast.info(`Template "${t.name}" vinculado! Editar o template atualizará todos os steps vinculados.`);
    }
  };

  // ==================== DISPATCH NOW ====================
  const handleDispatchNow = async () => {
    if (!selectedCampaign) return;
    setShowDispatchConfirm(false);
    setDispatching(true);
    try {
      const cadenceId = selectedCadence?.id || selectedCampaign.linkedCadences?.[0]?.id;
      const result = await (emailService as any).dispatchCampaignNow(selectedCampaign.id, cadenceId);
      toast.success(
        `Disparo iniciado: ${result.enrolled} novo(s) inscrito(s)` +
        (result.skipped ? `, ${result.skipped} já estavam inscritos` : '') +
        ` • ${result.processed} e-mail(s) processados agora`,
        { duration: 6000 },
      );
      // Atualiza apenas as métricas da campanha disparada — não recarrega o mundo todo,
      // o que zerava visualmente os outros KPIs durante o fetch.
      try {
        const stats = await emailService.getCampaignStats(selectedCampaign.id);
        setCampaigns(prev => prev.map(c => c.id === selectedCampaign.id ? { ...c, stats: { ...stats } } : c));
        setSelectedCampaign(prev => prev ? { ...prev, stats: { ...stats } } : prev);
      } catch { /* não crítico */ }
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao disparar campanha'));
    } finally {
      setDispatching(false);
    }
  };

  const openTemplateQuickEdit = (templateId: string) => {
    const t = templates.find(t => t.id === templateId);
    if (!t) return toast.error('Template não encontrado');
    setEditingTemplate(t);
    setTemplateForm({ name: t.name, subject: t.subject, bodyHtml: t.body_html, bodyText: t.body_text || '' });
  };

  const handleSaveTemplateQuick = async () => {
    if (!editingTemplate) return;
    setSavingTemplate(true);
    try {
      const updated = await emailService.updateTemplate(editingTemplate.id, templateForm);
      setTemplates(prev => prev.map(t => t.id === updated.id ? updated : t));
      // If currently editing a step linked to this template, sync the form fields too
      if (stepForm.templateId === updated.id) {
        setStepForm(prev => ({ ...prev, subject: updated.subject, bodyHtml: updated.body_html, bodyText: updated.body_text || '' }));
      }
      toast.success('Template atualizado! Próximos envios usarão a versão nova.');
      setEditingTemplate(null);
    } catch (err: any) {
      toast.error(friendlyEmailError(err, 'Erro ao salvar template'));
    } finally {
      setSavingTemplate(false);
    }
  };

  const triggerLabels: Record<string, string> = {
    opened: '📬 Abriu', clicked: '🖱️ Clicou', not_opened: '🚫 Não abriu', bounced: '⚠️ Bounce',
  };

  const stats = selectedCampaign?.stats || { total: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, bounced: 0, failed: 0, enrollments: 0 };
  const kpis = [
    { label: 'Enviados', value: stats.sent, icon: Send, color: 'text-blue-400' },
    { label: 'Entregues', value: stats.delivered, icon: Mail, color: 'text-emerald-400' },
    { label: 'Abertos', value: stats.opened, icon: Eye, color: 'text-violet-400' },
    { label: 'Clicados', value: stats.clicked, icon: MousePointer, color: 'text-cyan-400' },
    { label: 'Inscritos', value: stats.enrollments, icon: Users, color: 'text-amber-400' },
    { label: 'Falhas', value: stats.bounced + stats.failed, icon: AlertTriangle, color: 'text-destructive' },
  ];

  const cadences = selectedCampaign?.linkedCadences || [];
  const steps = selectedCadence?.steps || [];

  // Pré-condições para "Disparar agora" — usadas tanto no botão quanto no banner.
  const missingAudience = !!selectedCampaign && !selectedCampaign.audience;
  const missingCadence = !!selectedCampaign && !(selectedCampaign.linkedCadences?.length);
  const missingSteps =
    !!selectedCampaign &&
    !missingCadence &&
    !(selectedCampaign.linkedCadences || []).some(c => (c.steps?.length || 0) > 0);
  const dispatchBlocked = missingAudience || missingCadence || missingSteps;

  if (loading) {
    return <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-muted-foreground" /></div>;
  }

  // ==================== CAMPAIGN LIST VIEW ====================
  if (!selectedCampaign) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <FolderOpen className="w-5 h-5 text-primary" />
            <h3 className="text-lg font-semibold">Campanhas</h3>
          </div>
          <Button size="sm" onClick={() => { setEditingCampaign(null); setForm({ name: '', description: '', audienceId: '' }); setShowCreateDialog(true); }}>
            <Plus className="w-4 h-4 mr-1" /> Nova Campanha
          </Button>
        </div>

        {campaigns.length === 0 ? (
          <Card className="card-gradient border-border/50">
            <CardContent className="py-12 text-center text-muted-foreground">
              <FolderOpen className="w-12 h-12 mx-auto mb-3 opacity-50" />
              <p className="font-medium">Nenhuma campanha criada</p>
              <p className="text-sm mt-1">Crie sua primeira campanha para organizar seus e-mails.</p>
              <Button size="sm" className="mt-4" onClick={() => { setForm({ name: '', description: '', audienceId: '' }); setShowCreateDialog(true); }}>
                <Plus className="w-4 h-4 mr-1" /> Criar primeira campanha
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {campaigns.map(camp => (
              <Card
                key={camp.id}
                className="card-gradient border-border/50 cursor-pointer hover:border-primary/50 transition-all"
                onClick={() => { setSelectedCampaign(camp); setSelectedCadence(camp.linkedCadences?.[0] || null); setInnerTab('cadences'); }}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between mb-2">
                    <div>
                      <h4 className="font-semibold">{camp.name}</h4>
                      {camp.description && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{camp.description}</p>}
                    </div>
                    <Badge variant={camp.active ? 'default' : 'secondary'} className="text-[10px] flex-shrink-0">
                      {camp.active ? 'Ativa' : 'Inativa'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground mt-3">
                    {camp.audience && (
                      <span className="flex items-center gap-1"><Users className="w-3 h-3" /> {camp.audience.name} ({camp.audience.contact_count})</span>
                    )}
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {camp.linkedCadences?.length || 0} cadência(s)</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 mt-3">
                    <div className="text-center"><p className="text-lg font-bold">{camp.stats?.sent || 0}</p><p className="text-[10px] text-muted-foreground">Enviados</p></div>
                    <div className="text-center"><p className="text-lg font-bold">{camp.stats?.opened || 0}</p><p className="text-[10px] text-muted-foreground">Abertos</p></div>
                    <div className="text-center"><p className="text-lg font-bold">{camp.stats?.enrollments || 0}</p><p className="text-[10px] text-muted-foreground">Inscritos</p></div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Create Dialog */}
        {renderCampaignDialog()}
      </div>
    );
  }

  // ==================== CAMPAIGN DETAIL VIEW ====================
  return (
    <div className="space-y-4">
      {/* Back + Campaign header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => { setSelectedCampaign(null); setSelectedCadence(null); }}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-semibold">{selectedCampaign.name}</h3>
            <Badge variant={selectedCampaign.active ? 'default' : 'secondary'} className="text-[10px]">
              {selectedCampaign.active ? 'Ativa' : 'Inativa'}
            </Badge>
            {selectedCampaign.audience && (
              <Badge variant="outline" className="text-[10px] gap-1">
                <Users className="w-3 h-3" /> {selectedCampaign.audience.name} ({selectedCampaign.audience.contact_count})
              </Badge>
            )}
          </div>
          {selectedCampaign.description && <p className="text-sm text-muted-foreground">{selectedCampaign.description}</p>}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            onClick={() => setShowDispatchConfirm(true)}
            disabled={dispatching || !selectedCampaign.audience || !(selectedCampaign.linkedCadences?.length)}
            className="gap-1.5"
            title={
              !selectedCampaign.audience
                ? 'Vincule um público à campanha'
                : !selectedCampaign.linkedCadences?.length
                ? 'Crie ao menos uma cadência'
                : 'Inscreve o público e dispara o Step 1 imediatamente'
            }
          >
            {dispatching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            Disparar agora
          </Button>
          <Button variant="ghost" size="sm" onClick={() => {
            setEditingCampaign(selectedCampaign);
            setForm({ name: selectedCampaign.name, description: selectedCampaign.description || '', audienceId: (selectedCampaign as any).audience_id || '' });
            setShowCreateDialog(true);
          }}>
            <Edit2 className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setDeleteId(selectedCampaign.id)}>
            <Trash2 className="w-4 h-4 text-destructive" />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              if (!selectedCampaign) return loadData();
              try {
                const stats = await emailService.getCampaignStats(selectedCampaign.id);
                setCampaigns(prev => prev.map(c => c.id === selectedCampaign.id ? { ...c, stats: { ...stats } } : c));
                setSelectedCampaign(prev => prev ? { ...prev, stats: { ...stats } } : prev);
                toast.success('Métricas atualizadas');
              } catch (err: any) {
                toast.error(friendlyEmailError(err, 'Erro ao atualizar métricas'));
              }
            }}
            title="Atualizar métricas"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Banner: pré-requisitos para o disparo */}
      {dispatchBlocked && (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-3 px-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
            <div className="flex-1 text-xs">
              <p className="font-medium text-amber-200 mb-1">
                Esta campanha ainda não pode ser disparada.
              </p>
              <ul className="space-y-0.5 text-muted-foreground">
                {missingAudience && (
                  <li>• Vincule um <strong>público</strong> à campanha (botão de editar acima).</li>
                )}
                {missingCadence && (
                  <li>• Crie ao menos uma <strong>cadência</strong> na aba Cadências.</li>
                )}
                {missingSteps && (
                  <li>• Adicione ao menos um <strong>e-mail (step)</strong> em uma cadência.</li>
                )}
              </ul>
            </div>
          </CardContent>
        </Card>
      )}

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
        {kpis.map(kpi => (
          <Card key={kpi.label} className="card-gradient border-border/50">
            <CardContent className="p-2.5">
              <div className="flex items-center gap-2">
                <kpi.icon className={`w-4 h-4 ${kpi.color}`} />
                <div>
                  <p className="text-lg font-bold leading-tight">{kpi.value}</p>
                  <p className="text-[10px] text-muted-foreground">{kpi.label}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Inner Tabs */}
      <Tabs value={innerTab} onValueChange={setInnerTab}>
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="cadences" className="flex items-center gap-1.5 text-xs">
            <Clock className="w-3.5 h-3.5" /> Cadências
          </TabsTrigger>
          <TabsTrigger value="templates" className="flex items-center gap-1.5 text-xs">
            <FileText className="w-3.5 h-3.5" /> Templates
          </TabsTrigger>
          <TabsTrigger value="sends" className="flex items-center gap-1.5 text-xs">
            <Send className="w-3.5 h-3.5" /> Envios
          </TabsTrigger>
          <TabsTrigger value="inbox" className="flex items-center gap-1.5 text-xs">
            <Inbox className="w-3.5 h-3.5" /> Respostas
          </TabsTrigger>
          <TabsTrigger value="ai" className="flex items-center gap-1.5 text-xs">
            <Sparkles className="w-3.5 h-3.5" /> Assistente IA
          </TabsTrigger>
        </TabsList>

        {/* TAB: CADENCES */}
        <TabsContent value="cadences" className="mt-4 space-y-4">
          {/* Cadence list + selector */}
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-2">
              {cadences.length > 0 && (
                <Select
                  value={selectedCadence?.id || ''}
                  onValueChange={(v) => {
                    const c = cadences.find(c => c.id === v);
                    if (c) setSelectedCadence(c);
                  }}
                >
                  <SelectTrigger className="w-[200px] h-8 text-xs">
                    <SelectValue placeholder="Selecionar cadência..." />
                  </SelectTrigger>
                  <SelectContent>
                    {cadences.map(c => (
                      <SelectItem key={c.id} value={c.id}>
                        <span className="flex items-center gap-2">
                          <span className={`w-1.5 h-1.5 rounded-full ${c.active ? 'bg-emerald-500' : 'bg-muted-foreground'}`} />
                          {c.name}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <span className="text-xs text-muted-foreground">{cadences.length} cadência(s)</span>
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => {
                setEditingCadence(null);
                setCadenceForm({ name: '', description: '', sendAtTime: '09:00', startDate: new Date().toISOString().split('T')[0] });
                setShowCadenceDialog(true);
              }}>
                <Plus className="w-4 h-4 mr-1" /> Nova Cadência
              </Button>
              {selectedCadence && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => {
                    setEditingCadence(selectedCadence);
                    setCadenceForm({ name: selectedCadence.name, description: selectedCadence.description || '', sendAtTime: selectedCadence.send_at_time || '09:00', startDate: selectedCadence.start_date || new Date().toISOString().split('T')[0] });
                    setShowCadenceDialog(true);
                  }}>
                    <Edit2 className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => handleDeleteCadence(selectedCadence.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </>
              )}
            </div>
          </div>

          {/* Steps timeline */}
          {selectedCadence ? (
            <Card className="card-gradient border-border/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <Clock className="w-4 h-4" />
                    Steps — {selectedCadence.name}
                    {selectedCadence.send_at_time && <span className="text-xs text-muted-foreground font-normal">às {selectedCadence.send_at_time}</span>}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                {steps.length === 0 ? (
                  <button
                    className="w-full py-6 rounded-lg border-2 border-dashed border-primary/40 hover:border-primary hover:bg-primary/5 transition-colors flex flex-col items-center gap-2 text-sm"
                    onClick={() => {
                      setEditingStep(null);
                      setStepForm({ dayNumber: 1, subject: '', bodyHtml: '', bodyText: '', templateId: null });
                      setShowStepAI(false);
                      setShowStepDialog(true);
                    }}
                  >
                    <Plus className="w-6 h-6 text-primary" />
                    <span className="font-medium">Adicionar primeiro e-mail</span>
                    <span className="text-xs text-muted-foreground">
                      Sem ao menos um step, o disparo não envia nada.
                    </span>
                  </button>
                ) : (
                <div className="flex items-start gap-2 overflow-x-auto pb-2">
                  {steps.map((step, idx) => (
                    <div key={step.id} className="flex items-center gap-2">
                      <div
                        onClick={() => setExpandedStepId(prev => prev === step.id ? null : step.id)}
                        className={`relative min-w-[130px] p-3 rounded-lg border-2 cursor-pointer transition-all ${
                          expandedStepId === step.id
                            ? 'border-primary bg-primary/10 ring-2 ring-primary/30'
                            : idx === 0 ? 'border-primary/60 bg-primary/5' : 'border-border bg-muted/30 hover:border-primary/40'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-semibold">Dia {step.day_number}</span>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={(e) => e.stopPropagation()}><MoreHorizontal className="w-3 h-3" /></Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent>
                              <DropdownMenuItem onClick={() => setPreviewStep(step)}><Eye className="w-3 h-3 mr-2" /> Preview</DropdownMenuItem>
                              <DropdownMenuItem onClick={() => {
                                setEditingStep(step);
                                setStepForm({ dayNumber: step.day_number, subject: step.subject, bodyHtml: step.body_html, bodyText: step.body_text || '', templateId: step.template_id || null });
                                setShowStepAI(false); setShowStepDialog(true);
                              }}><Edit2 className="w-3 h-3 mr-2" /> Editar</DropdownMenuItem>
                              {step.template_id && (
                                <DropdownMenuItem onClick={() => openTemplateQuickEdit(step.template_id!)}>
                                  <FileText className="w-3 h-3 mr-2" /> Editar template
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuItem className="text-destructive" onClick={() => handleDeleteStep(step.id)}><Trash2 className="w-3 h-3 mr-2" /> Excluir</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">{step.subject}</p>
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                          <Badge variant={step.active ? 'default' : 'secondary'} className="text-[10px]">{step.active ? '● Ativo' : '● Inativo'}</Badge>
                          {step.template_id && (
                            <Badge variant="outline" className="text-[10px] gap-1">
                              <FileText className="w-2.5 h-2.5" />
                              {templates.find(t => t.id === step.template_id)?.name || 'Template'}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {idx < steps.length - 1 && <ChevronRight className="w-4 h-4 text-muted-foreground flex-shrink-0" />}
                    </div>
                  ))}
                  <button
                    className="min-w-[50px] h-[80px] rounded-lg border-2 border-dashed border-border flex items-center justify-center hover:bg-muted/50 transition-colors"
                    onClick={() => {
                      setEditingStep(null);
                      const nextDay = steps.length > 0 ? Math.max(...steps.map(s => s.day_number)) + 2 : 1;
                      setStepForm({ dayNumber: nextDay, subject: '', bodyHtml: '', bodyText: '', templateId: null });
                      setShowStepAI(false); setShowStepDialog(true);
                    }}
                  >
                    <Plus className="w-5 h-5 text-muted-foreground" />
                  </button>
                </div>
                )}
                {steps.length > 0 && (
                  <p className="text-[10px] text-muted-foreground mt-2">
                    💡 Clique em um step para ver quem vai receber / quem já recebeu este e-mail.
                  </p>
                )}
                {expandedStepId && steps.find(s => s.id === expandedStepId) && (
                  <div className="mt-4 pt-4 border-t border-border/50 space-y-3">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <Users className="w-4 h-4 text-primary" />
                      Destinatários — Dia {steps.find(s => s.id === expandedStepId)?.day_number} ·{' '}
                      <span className="text-muted-foreground font-normal truncate">
                        {steps.find(s => s.id === expandedStepId)?.subject}
                      </span>
                    </div>
                    <StepRecipientsPanel
                      key={expandedStepId}
                      cadenceId={selectedCadence.id}
                      stepId={expandedStepId}
                      stepDayNumber={steps.find(s => s.id === expandedStepId)?.day_number || 1}
                      cadenceStartDate={selectedCadence.start_date}
                      cadenceSendAtTime={selectedCadence.send_at_time}
                    />
                  </div>
                )}
              </CardContent>
            </Card>
          ) : (
            <Card className="card-gradient border-border/50">
              <CardContent className="py-8 text-center text-muted-foreground">
                <Clock className="w-10 h-10 mx-auto mb-2 opacity-50" />
                <p className="text-sm font-medium">Nenhuma cadência nesta campanha</p>
                <p className="text-xs mt-1">Crie uma cadência para definir a sequência de e-mails.</p>
              </CardContent>
            </Card>
          )}

          {/* Branching Rules */}
          {selectedCadence && (
            <Card className="card-gradient border-border/50">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <GitBranch className="w-4 h-4" /> Ramificações saindo de
                    <Badge variant="outline" className="text-xs ml-1 max-w-[180px] truncate">
                      {selectedCadence.name}
                    </Badge>
                  </CardTitle>
                  <Button variant="ghost" size="sm" onClick={() => {
                    setRuleForm({ triggerEvent: 'opened', targetCadenceId: '', delayHours: 0, timeoutHours: 48 });
                    setShowRuleDialog(true);
                  }}>
                    <Plus className="w-4 h-4 mr-1" /> Nova Regra
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Regras movem leads <strong>desta cadência</strong> para outra quando o evento ocorre.
                  Para ver regras que terminam aqui, selecione a cadência de origem.
                </p>
              </CardHeader>
              <CardContent>
                {(selectedCadence.rules || []).length === 0 ? (
                  <p className="text-center text-sm text-muted-foreground py-3">
                    Nenhuma regra saindo de <strong>{selectedCadence.name}</strong>.
                    Clique em "Nova Regra" para criar uma ramificação a partir desta cadência.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {(selectedCadence.rules || []).map(rule => (
                      <div key={rule.id} className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border/50">
                        <div className="flex items-center gap-2 text-sm">
                          <Badge variant="outline" className="text-xs">{triggerLabels[rule.trigger_event] || rule.trigger_event}</Badge>
                          <ChevronRight className="w-3 h-3 text-muted-foreground" />
                          <span className="font-medium">{rule.target_cadence?.name || 'Cadência'}</span>
                          {rule.delay_hours > 0 && <Badge variant="secondary" className="text-[10px]">+{rule.delay_hours}h</Badge>}
                        </div>
                        <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => handleDeleteRule(rule.id)}>
                          <Trash2 className="w-3 h-3 text-destructive" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* TAB: TEMPLATES */}
        <TabsContent value="templates" className="mt-4">
          <EmailTemplatesTab />
        </TabsContent>

        {/* TAB: SENDS */}
        <TabsContent value="sends" className="mt-4">
          <EmailSendsTab />
        </TabsContent>

        {/* TAB: INBOX/REPLIES */}
        <TabsContent value="inbox" className="mt-4">
          <EmailInboxTab />
        </TabsContent>

        {/* TAB: AI ASSISTANT */}
        <TabsContent value="ai" className="mt-4">
          <Card className="card-gradient border-border/50">
            <CardContent className="p-4">
              <EmailAIChat
                onApply={(email) => {
                  setStepForm(prev => ({ ...prev, subject: email.subject || prev.subject, bodyHtml: email.bodyHtml, bodyText: email.bodyText }));
                  setShowStepDialog(true);
                  setInnerTab('cadences');
                  toast.info('Conteúdo aplicado — configure o step e salve!');
                }}
                onClose={() => setInnerTab('cadences')}
                context={{ currentSubject: '', currentBodyHtml: '' }}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ==================== DIALOGS ==================== */}
      {renderCampaignDialog()}

      {/* Cadence Dialog */}
      <Dialog open={showCadenceDialog} onOpenChange={setShowCadenceDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingCadence ? 'Editar Cadência' : 'Nova Cadência'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Nome</label>
              <Input value={cadenceForm.name} onChange={e => setCadenceForm(p => ({ ...p, name: e.target.value }))} placeholder="Ex: Cadência de Boas-vindas" />
            </div>
            <div>
              <label className="text-sm font-medium">Descrição</label>
              <Textarea value={cadenceForm.description} onChange={e => setCadenceForm(p => ({ ...p, description: e.target.value }))} rows={2} />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Data de início</label>
                <Input type="date" value={cadenceForm.startDate} onChange={e => setCadenceForm(p => ({ ...p, startDate: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm font-medium">Horário de envio</label>
                <Input type="time" value={cadenceForm.sendAtTime} onChange={e => setCadenceForm(p => ({ ...p, sendAtTime: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCadenceDialog(false)}>Cancelar</Button>
            <Button onClick={handleSaveCadence} disabled={!cadenceForm.name.trim()}>{editingCadence ? 'Salvar' : 'Criar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Step Dialog — apenas anexa template + dia */}
      <Dialog open={showStepDialog} onOpenChange={setShowStepDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingStep ? 'Editar Step' : 'Novo Step'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {templates.length === 0 ? (
              <div className="rounded-md border border-dashed border-border p-4 text-center space-y-2">
                <FileText className="w-6 h-6 mx-auto text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  Nenhum template disponível. Crie um template (manual ou com IA) na aba <strong>Templates</strong> antes de adicionar steps.
                </p>
                <Button size="sm" variant="outline" onClick={() => { setShowStepDialog(false); setInnerTab('templates'); }}>
                  Ir para Templates
                </Button>
              </div>
            ) : (
              <>
                <div>
                  <label className="text-sm font-medium">Dia do envio</label>
                  <Input
                    type="number"
                    min={1}
                    value={stepForm.dayNumber}
                    onChange={e => setStepForm(p => ({ ...p, dayNumber: parseInt(e.target.value) || 1 }))}
                  />
                  <p className="text-xs text-muted-foreground mt-1">Quantos dias após a inscrição este e-mail será enviado.</p>
                </div>
                <div>
                  <label className="text-sm font-medium flex items-center justify-between">
                    <span>Template <span className="text-destructive">*</span></span>
                    {stepForm.templateId && (
                      <button
                        type="button"
                        className="text-xs text-primary hover:underline flex items-center gap-1"
                        onClick={() => openTemplateQuickEdit(stepForm.templateId!)}
                      >
                        <Edit2 className="w-3 h-3" /> Editar template
                      </button>
                    )}
                  </label>
                  <Select
                    value={stepForm.templateId || ''}
                    onValueChange={(v) => handleLoadTemplate(v)}
                  >
                    <SelectTrigger><SelectValue placeholder="Selecione um template..." /></SelectTrigger>
                    <SelectContent>
                      {templates.map(t => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground mt-1">
                    O conteúdo do e-mail vem do template. Para alterar assunto ou corpo, edite o template.
                  </p>
                </div>
                {stepForm.templateId && stepForm.subject && (
                  <div className="rounded-md bg-muted/40 border border-border p-3 space-y-1">
                    <p className="text-xs text-muted-foreground">Prévia do assunto</p>
                    <p className="text-sm font-medium truncate">{stepForm.subject}</p>
                  </div>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStepDialog(false)}>Cancelar</Button>
            {stepForm.templateId && stepForm.bodyHtml.trim() && (
              <Button
                variant="secondary"
                onClick={() => setPreviewStep({
                  id: editingStep?.id || 'preview',
                  cadence_id: selectedCadence?.id || '',
                  day_number: stepForm.dayNumber,
                  subject: stepForm.subject,
                  body_html: stepForm.bodyHtml,
                  body_text: stepForm.bodyText || null,
                  ordem: 0, active: true, created_at: '', updated_at: '',
                })}
              >
                <Eye className="w-4 h-4 mr-1" /> Preview
              </Button>
            )}
            <Button onClick={handleSaveStep} disabled={!stepForm.templateId || !stepForm.subject.trim() || !stepForm.bodyHtml.trim()}>
              {editingStep ? 'Salvar' : 'Criar Step'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rule Dialog */}
      <Dialog open={showRuleDialog} onOpenChange={setShowRuleDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova Regra de Ramificação</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Quando o lead...</label>
              <Select value={ruleForm.triggerEvent} onValueChange={v => setRuleForm(p => ({ ...p, triggerEvent: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="opened">📬 Abrir o e-mail</SelectItem>
                  <SelectItem value="clicked">🖱️ Clicar no link</SelectItem>
                  <SelectItem value="not_opened">🚫 Não abrir (timeout)</SelectItem>
                  <SelectItem value="bounced">⚠️ Bounce</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {ruleForm.triggerEvent === 'not_opened' && (
              <div>
                <label className="text-sm font-medium">Timeout (horas)</label>
                <Input type="number" min={1} value={ruleForm.timeoutHours} onChange={e => setRuleForm(p => ({ ...p, timeoutHours: parseInt(e.target.value) || 48 }))} />
              </div>
            )}
            <div>
              <label className="text-sm font-medium">Mover para cadência:</label>
              <Select value={ruleForm.targetCadenceId} onValueChange={v => setRuleForm(p => ({ ...p, targetCadenceId: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecione..." /></SelectTrigger>
                <SelectContent>
                  {cadences.filter(c => c.id !== selectedCadence?.id).map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Delay antes de mover (horas)</label>
              <Input type="number" min={0} value={ruleForm.delayHours} onChange={e => setRuleForm(p => ({ ...p, delayHours: parseInt(e.target.value) || 0 }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRuleDialog(false)}>Cancelar</Button>
            <Button onClick={handleSaveRule} disabled={!ruleForm.targetCadenceId}>Criar Regra</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview */}
      <EmailPreviewDialog
        open={!!previewStep}
        onOpenChange={open => !open && setPreviewStep(null)}
        subject={previewStep?.subject || ''}
        bodyHtml={previewStep?.body_html || ''}
        bodyText={previewStep?.body_text || undefined}
      />

      {/* Delete Campaign */}
      <AlertDialog open={!!deleteId} onOpenChange={open => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir campanha?</AlertDialogTitle>
            <AlertDialogDescription>As cadências vinculadas também serão excluídas.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteCampaign} className="bg-destructive text-destructive-foreground">Excluir</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Dispatch Now confirmation */}
      <AlertDialog open={showDispatchConfirm} onOpenChange={setShowDispatchConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disparar campanha agora?</AlertDialogTitle>
            <AlertDialogDescription>
              Todos os contatos do público <strong>{selectedCampaign?.audience?.name}</strong>
              {selectedCampaign?.audience?.contact_count != null && ` (${selectedCampaign.audience.contact_count} contatos)`} serão inscritos na cadência <strong>{selectedCadence?.name || selectedCampaign?.linkedCadences?.[0]?.name}</strong> e o <strong>Step 1</strong> será enviado imediatamente.
              <br /><br />
              Contatos já inscritos serão ignorados. Os envios contam nas métricas.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={handleDispatchNow}>
              <Zap className="w-4 h-4 mr-1" /> Disparar agora
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Quick template editor (opened from a step) */}
      <Dialog open={!!editingTemplate} onOpenChange={(open) => !open && setEditingTemplate(null)}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle>Editar template: {editingTemplate?.name}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
            <div>
              <label className="text-sm font-medium">Nome</label>
              <Input value={templateForm.name} onChange={e => setTemplateForm(p => ({ ...p, name: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium">Assunto</label>
              <Input value={templateForm.subject} onChange={e => setTemplateForm(p => ({ ...p, subject: e.target.value }))} />
            </div>
            <div>
              <label className="text-sm font-medium mb-1 block">Corpo do e-mail</label>
              <EmailRichEditor
                value={templateForm.bodyHtml}
                onChange={html => setTemplateForm(p => ({ ...p, bodyHtml: html }))}
                placeholder="Conteúdo do template..."
                minHeight="250px"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              💡 Editar este template atualizará todos os passos vinculados nos próximos envios.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingTemplate(null)}>Cancelar</Button>
            <Button onClick={handleSaveTemplateQuick} disabled={savingTemplate || !templateForm.name.trim() || !templateForm.subject.trim() || !templateForm.bodyHtml.trim()}>
              {savingTemplate ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Salvar template
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );

  // ==================== RENDER HELPERS ====================
  function renderCampaignDialog() {
    return (
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingCampaign ? 'Editar Campanha' : 'Nova Campanha'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Nome</label>
              <Input value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))} placeholder="Ex: Black Friday 2026" />
            </div>
            <div>
              <label className="text-sm font-medium">Descrição</label>
              <Textarea value={form.description} onChange={e => setForm(p => ({ ...p, description: e.target.value }))} rows={2} />
            </div>
            <div>
              <label className="text-sm font-medium">Público alvo</label>
              <Select value={form.audienceId} onValueChange={v => setForm(p => ({ ...p, audienceId: v }))}>
                <SelectTrigger><SelectValue placeholder="Selecionar público..." /></SelectTrigger>
                <SelectContent>
                  {audiences.map(a => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.name} ({a.contact_count || 0} contatos)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {audiences.length === 0 && <p className="text-xs text-muted-foreground mt-1">Crie um público na aba "Públicos" primeiro.</p>}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>Cancelar</Button>
            <Button onClick={handleSaveCampaign} disabled={!form.name.trim()}>{editingCampaign ? 'Salvar' : 'Criar'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }
}
