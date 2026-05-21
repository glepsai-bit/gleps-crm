import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from 'sonner';
import {
  Inbox, Mail, MailOpen, Reply, Loader2, ChevronLeft, User, Clock, Send,
  RefreshCw, Sparkles, MoreHorizontal, PauseCircle, PlayCircle, UserMinus,
  CheckCircle2, AlertTriangle, Info, Copy, Check
} from 'lucide-react';
import {
  emailService,
  type EmailInboxMessage,
  type InboxDiagnostics,
} from '@/services/email.service';
import EmailRichEditor from './EmailRichEditor';

export default function EmailInboxTab() {
  const [messages, setMessages] = useState<EmailInboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMessage, setSelectedMessage] = useState<EmailInboxMessage | null>(null);
  const [showReply, setShowReply] = useState(false);
  const [replySubject, setReplySubject] = useState('');
  const [replyBody, setReplyBody] = useState('');
  const [sending, setSending] = useState(false);
  const [generatingAI, setGeneratingAI] = useState(false);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [diagnostics, setDiagnostics] = useState<InboxDiagnostics | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [confirmAction, setConfirmAction] = useState<null | { type: 'pause' | 'unenroll' | 'replied'; messageId: string }>(null);

  const loadMessages = useCallback(async () => {
    setLoading(true);
    try {
      const readFilter = filter === 'unread' ? false : undefined;
      const [msgs, diag] = await Promise.all([
        emailService.listInboxMessages({ read: readFilter, limit: 100 }),
        emailService.getInboxDiagnostics().catch(() => null),
      ]);
      setMessages(msgs);
      if (diag) setDiagnostics(diag);
    } catch (err) {
      console.error('Erro ao carregar inbox:', err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { loadMessages(); }, [loadMessages]);

  const handleSelectMessage = async (msg: EmailInboxMessage) => {
    setSelectedMessage(msg);
    setShowReply(false);

    if (!msg.read) {
      try {
        await emailService.markInboxRead(msg.id);
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, read: true } : m));
      } catch {}
    }
  };

  const handleReply = async () => {
    if (!selectedMessage || !replyBody.trim()) return;
    setSending(true);
    try {
      await emailService.replyToMessage(selectedMessage.id, {
        subject: replySubject || `Re: ${selectedMessage.subject}`,
        bodyHtml: replyBody,
      });
      toast.success('Resposta enviada!');
      setShowReply(false);
      setReplyBody('');
      setReplySubject('');
      setSelectedMessage(prev => prev ? { ...prev, replied: true, replied_at: new Date().toISOString() } : null);
      setMessages(prev => prev.map(m => m.id === selectedMessage.id ? { ...m, replied: true } : m));
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao enviar resposta');
    } finally {
      setSending(false);
    }
  };

  const handleSuggestAI = async () => {
    if (!selectedMessage) return;
    setGeneratingAI(true);
    try {
      const result = await emailService.suggestReply(selectedMessage.id);
      if (result?.bodyHtml) {
        setReplyBody(result.bodyHtml);
        if (result.subject) setReplySubject(result.subject);
        toast.success('Resposta sugerida pela IA');
      } else {
        toast.error('IA não retornou conteúdo. Verifique a chave OpenAI.');
      }
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao gerar resposta com IA');
    } finally {
      setGeneratingAI(false);
    }
  };

  const handleAction = async () => {
    if (!confirmAction) return;
    const { type, messageId } = confirmAction;
    try {
      if (type === 'pause') {
        await emailService.pauseEnrollmentFromInbox(messageId);
        toast.success('Cadência pausada para este lead');
      } else if (type === 'unenroll') {
        await emailService.unenrollFromInbox(messageId);
        toast.success('Lead removido da cadência');
      } else if (type === 'replied') {
        await emailService.markInboxRepliedManually(messageId);
        toast.success('Marcado como respondido manualmente');
        setMessages(prev => prev.map(m => m.id === messageId ? { ...m, replied: true, read: true } : m));
        setSelectedMessage(prev => prev?.id === messageId ? { ...prev, replied: true } : prev);
      }
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao executar ação');
    } finally {
      setConfirmAction(null);
    }
  };

  const handleResume = async (messageId: string) => {
    try {
      await emailService.resumeEnrollmentFromInbox(messageId);
      toast.success('Cadência retomada');
    } catch (err: any) {
      toast.error(err?.message || 'Erro ao retomar');
    }
  };

  const copyWebhookUrl = () => {
    if (!diagnostics?.webhookUrl) return;
    navigator.clipboard.writeText(diagnostics.webhookUrl);
    setCopiedUrl(true);
    toast.success('URL copiada');
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const unreadCount = messages.filter(m => !m.read).length;

  const formatDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffH = diffMs / (1000 * 60 * 60);

    if (diffH < 1) return `${Math.floor(diffMs / 60000)}min`;
    if (diffH < 24) return `${Math.floor(diffH)}h`;
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  };

  // Diagnostic panel
  const renderDiagnostics = () => {
    if (!diagnostics) return null;
    const noMessages = diagnostics.totalMessages === 0;
    return (
      <Alert className={noMessages ? 'border-amber-500/50 bg-amber-500/5' : 'border-emerald-500/50 bg-emerald-500/5'}>
        <div className="flex items-start gap-2 w-full">
          {noMessages ? (
            <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-foreground">
                {noMessages ? 'Nenhuma resposta recebida ainda' : `${diagnostics.totalMessages} resposta(s) recebida(s)`}
              </p>
              <Button size="sm" variant="ghost" className="h-6 text-xs" onClick={() => setShowDiag(s => !s)}>
                {showDiag ? 'Ocultar' : 'Como configurar?'}
              </Button>
            </div>
            <AlertDescription className="text-xs text-muted-foreground mt-1">
              {noMessages
                ? 'Para receber respostas dos leads aqui, é necessário configurar o redirecionamento de e-mails de retorno (Inbound Parse) no provedor.'
                : `Última recebida ${diagnostics.latestReceivedAt ? new Date(diagnostics.latestReceivedAt).toLocaleString('pt-BR') : ''} de ${diagnostics.latestFromEmail || ''}.`}
            </AlertDescription>
            {showDiag && (
              <div className="mt-3 space-y-2 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">Webhook URL (cole no provedor):</span>
                </div>
                <div className="flex items-center gap-2 bg-muted/50 p-2 rounded">
                  <code className="text-[11px] flex-1 break-all">{diagnostics.webhookUrl}</code>
                  <Button size="sm" variant="ghost" className="h-6 w-6 p-0" onClick={copyWebhookUrl}>
                    {copiedUrl ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                  </Button>
                </div>
                <ol className="list-decimal list-inside space-y-1 text-muted-foreground pl-1 mt-2">
                  <li>No painel do provedor de e-mail, ative o Inbound Parse.</li>
                  <li>Configure um registro <strong>MX</strong> apontando o subdomínio (ex: <code>reply.seudominio.com</code>) para <code>mx.sendgrid.net</code>.</li>
                  <li>No Inbound Parse, defina o host como esse subdomínio e a URL de destino conforme acima.</li>
                  <li>Os e-mails das cadências passarão a usar esse domínio como Reply-To automaticamente.</li>
                </ol>
                <div className="flex items-center gap-3 pt-1 text-muted-foreground">
                  <span className={diagnostics.sendgridConfigured ? 'text-emerald-600' : 'text-amber-600'}>
                    {diagnostics.sendgridConfigured ? '✓ Provedor de e-mail configurado' : '⚠ Provedor não configurado'}
                  </span>
                  {diagnostics.sendgridFromEmail && (
                    <span>· De: {diagnostics.sendgridFromEmail}</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </Alert>
    );
  };

  if (loading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Detail View
  if (selectedMessage) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => { setSelectedMessage(null); setShowReply(false); }}>
              <ChevronLeft className="w-4 h-4 mr-1" /> Voltar
            </Button>
            {selectedMessage.replied && (
              <Badge variant="secondary" className="text-xs">✓ Respondido</Badge>
            )}
            {selectedMessage.enrollment_id && (
              <Badge variant="outline" className="text-xs gap-1">
                <PauseCircle className="w-3 h-3" /> Cadência pausada (auto)
              </Badge>
            )}
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <MoreHorizontal className="w-4 h-4 mr-1" /> Ações
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {!selectedMessage.replied && (
                <DropdownMenuItem onClick={() => setConfirmAction({ type: 'replied', messageId: selectedMessage.id })}>
                  <CheckCircle2 className="w-4 h-4 mr-2" /> Marcar como respondido
                </DropdownMenuItem>
              )}
              {selectedMessage.enrollment_id && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => handleResume(selectedMessage.id)}>
                    <PlayCircle className="w-4 h-4 mr-2" /> Retomar cadência
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setConfirmAction({ type: 'pause', messageId: selectedMessage.id })}>
                    <PauseCircle className="w-4 h-4 mr-2" /> Pausar cadência
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setConfirmAction({ type: 'unenroll', messageId: selectedMessage.id })}
                    className="text-destructive"
                  >
                    <UserMinus className="w-4 h-4 mr-2" /> Remover da cadência
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <Card className="card-gradient border-border/50">
          <CardContent className="p-6 space-y-4">
            {/* Header */}
            <div className="space-y-2">
              <h3 className="text-lg font-semibold text-foreground">{selectedMessage.subject}</h3>
              <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
                <div className="flex items-center gap-1.5">
                  <User className="w-4 h-4" />
                  <span className="font-medium text-foreground">
                    {selectedMessage.contact?.nome || selectedMessage.from_email}
                  </span>
                  <span>{'<'}{selectedMessage.from_email}{'>'}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span>{new Date(selectedMessage.received_at).toLocaleString('pt-BR')}</span>
                </div>
              </div>
            </div>

            <Separator />

            {/* Body */}
            <div className="min-h-[200px]">
              {selectedMessage.body_html ? (
                <div
                  className="prose prose-sm max-w-none text-foreground"
                  dangerouslySetInnerHTML={{ __html: selectedMessage.body_html }}
                />
              ) : (
                <pre className="whitespace-pre-wrap text-sm text-foreground font-sans">
                  {selectedMessage.body_text || '(Sem conteúdo)'}
                </pre>
              )}
            </div>

            <Separator />

            {/* Reply section */}
            {!showReply ? (
              <div className="flex items-center gap-2">
                <Button onClick={() => {
                  setShowReply(true);
                  setReplySubject(`Re: ${selectedMessage.subject}`);
                }}>
                  <Reply className="w-4 h-4 mr-2" /> Responder
                </Button>
                <Button variant="outline" onClick={() => {
                  setShowReply(true);
                  setReplySubject(`Re: ${selectedMessage.subject}`);
                  handleSuggestAI();
                }}>
                  <Sparkles className="w-4 h-4 mr-2" /> Responder com IA
                </Button>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold flex items-center gap-2">
                    <Reply className="w-4 h-4" /> Responder
                  </h4>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleSuggestAI}
                    disabled={generatingAI}
                  >
                    {generatingAI
                      ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                      : <Sparkles className="w-3.5 h-3.5 mr-1.5" />}
                    Sugerir com IA
                  </Button>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Assunto</label>
                  <Input
                    value={replySubject}
                    onChange={(e) => setReplySubject(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-1 block">Mensagem</label>
                  <EmailRichEditor
                    value={replyBody}
                    onChange={setReplyBody}
                    placeholder="Escreva sua resposta..."
                    minHeight="180px"
                  />
                </div>
                <div className="flex gap-2 justify-end">
                  <Button variant="outline" size="sm" onClick={() => setShowReply(false)}>
                    Cancelar
                  </Button>
                  <Button size="sm" onClick={handleReply} disabled={sending || !replyBody.trim()}>
                    {sending ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Send className="w-4 h-4 mr-1" />}
                    Enviar
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <ActionConfirmDialog
          action={confirmAction}
          onCancel={() => setConfirmAction(null)}
          onConfirm={handleAction}
        />
      </div>
    );
  }

  // List View
  return (
    <div className="space-y-4">
      {renderDiagnostics()}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted-foreground">
            Respostas recebidas dos leads
            {unreadCount > 0 && (
              <Badge variant="destructive" className="ml-2 text-xs">{unreadCount} não lida{unreadCount > 1 ? 's' : ''}</Badge>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={filter === 'all' ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('all')}
          >
            Todas
          </Button>
          <Button
            variant={filter === 'unread' ? 'default' : 'outline'}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setFilter('unread')}
          >
            Não lidas
          </Button>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={loadMessages}>
            <RefreshCw className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {messages.length === 0 ? (
        <Card className="card-gradient border-border/50">
          <CardContent className="py-12 text-center">
            <Inbox className="w-12 h-12 mx-auto mb-3 text-muted-foreground opacity-50" />
            <p className="font-medium text-muted-foreground">Nenhuma resposta recebida</p>
            <p className="text-sm text-muted-foreground mt-1">
              Quando um lead responder a um e-mail da cadência, a mensagem aparecerá aqui.
            </p>
            <div className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted/30 px-3 py-1.5 rounded-full">
              <Info className="w-3 h-3" />
              Configure o Inbound Parse no painel acima para começar a receber.
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="card-gradient border-border/50 overflow-hidden">
          <div className="divide-y divide-border">
            {messages.map((msg) => (
              <button
                key={msg.id}
                className={`w-full text-left px-4 py-3 hover:bg-muted/30 transition-colors flex items-start gap-3 ${
                  !msg.read ? 'bg-primary/5' : ''
                }`}
                onClick={() => handleSelectMessage(msg)}
              >
                <div className="mt-0.5 flex-shrink-0">
                  {msg.read ? (
                    <MailOpen className="w-4 h-4 text-muted-foreground" />
                  ) : (
                    <Mail className="w-4 h-4 text-primary" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`text-sm truncate ${!msg.read ? 'font-semibold text-foreground' : 'text-foreground'}`}>
                      {msg.contact?.nome || msg.from_email}
                    </span>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatDate(msg.received_at)}
                    </span>
                  </div>
                  <p className={`text-sm truncate ${!msg.read ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>
                    {msg.subject}
                  </p>
                  <p className="text-xs text-muted-foreground truncate mt-0.5">
                    {msg.body_text?.substring(0, 100) || '(Sem prévia)'}
                  </p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  {msg.replied && (
                    <Badge variant="outline" className="text-[10px]">Respondido</Badge>
                  )}
                  {!msg.read && (
                    <div className="w-2 h-2 rounded-full bg-primary" />
                  )}
                </div>
              </button>
            ))}
          </div>
        </Card>
      )}

      <ActionConfirmDialog
        action={confirmAction}
        onCancel={() => setConfirmAction(null)}
        onConfirm={handleAction}
      />
    </div>
  );
}

interface ActionConfirmProps {
  action: null | { type: 'pause' | 'unenroll' | 'replied'; messageId: string };
  onCancel: () => void;
  onConfirm: () => void;
}
function ActionConfirmDialog({ action, onCancel, onConfirm }: ActionConfirmProps) {
  const titles = {
    pause: 'Pausar cadência?',
    unenroll: 'Remover da cadência?',
    replied: 'Marcar como respondido?',
  };
  const descs = {
    pause: 'O lead deixará de receber novos e-mails desta cadência. Você pode retomar a qualquer momento.',
    unenroll: 'O lead será removido permanentemente da cadência e não receberá mais nenhum e-mail dela.',
    replied: 'A mensagem será marcada como respondida (use isso quando você responder por outro canal).',
  };
  return (
    <AlertDialog open={!!action} onOpenChange={(open) => !open && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{action ? titles[action.type] : ''}</AlertDialogTitle>
          <AlertDialogDescription>{action ? descs[action.type] : ''}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Confirmar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
