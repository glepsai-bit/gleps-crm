import { useState, useEffect, useRef } from 'react';
import { CalendarView, GoogleConnectModal } from '@/components/calendar';
import { useCalendar } from '@/contexts/CalendarContext';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { format, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Calendar, Clock, MapPin, Link2, User, Trash2, Copy, ExternalLink, RefreshCw, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';

export default function AdminAgendaPage() {
  const { 
    selectedEvent, 
    selectEvent, 
    deleteEvent, 
    isConnected, 
    isLoading,
    isInitialized,
    loadEvents,
    connection, 
    connectGoogle, 
    disconnectGoogle, 
    syncNow,
    checkConnectionStatus,
    googleConfigured,
    googleMissing,
  } = useCalendar();
  
  const [showConnectModal, setShowConnectModal] = useState(false);
  
  // Ref to track if we've already attempted sync for this callback
  const syncAttemptedRef = useRef(false);

  // Handle OAuth callback - runs once on mount, uses window.location to avoid re-render loops
  useEffect(() => {
    if (syncAttemptedRef.current) return;
    
    const params = new URLSearchParams(window.location.search);
    const googleConnected = params.get('google_connected') || params.get('google');
    const forceSync = params.get('force_sync');
    const error = params.get('error') || params.get('google_error');

    // Nothing to handle
    if (!error && !googleConnected && !forceSync) return;

    // Clear URL immediately without causing re-render
    window.history.replaceState({}, '', window.location.pathname);
    syncAttemptedRef.current = true;

    // Handle errors first
    if (error) {
      const errorMessages: Record<string, string> = {
        oauth_denied: 'Você cancelou a autorização',
        invalid_params: 'Parâmetros inválidos',
        config_error: 'Erro de configuração. Contate o suporte.',
        token_exchange: 'Erro ao obter tokens',
        missing_tokens: 'Tokens não recebidos',
        db_error: 'Erro ao salvar conexão',
        invalid_state: 'Estado inválido',
        unknown: 'Erro desconhecido',
      };
      toast.error(errorMessages[error] || 'Erro ao conectar');
      return;
    }

    // Handle successful OAuth callback
    if (googleConnected === 'true' || googleConnected === 'connected') {
      console.log('[Agenda] OAuth callback detected, google_connected:', googleConnected);
      toast.success('Google Calendar conectado! Sincronizando eventos...');
      
      const runSync = async () => {
        console.log('[Agenda] Running post-OAuth sync...');
        await checkConnectionStatus();
        await syncNow();
        await loadEvents();
        console.log('[Agenda] Post-OAuth sync complete');
      };
      
      setTimeout(runSync, 500);
    } else if (forceSync === 'true') {
      console.log('[Agenda] force_sync detected');
      setTimeout(() => syncNow(), 500);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isSyncing = connection.status === 'syncing';
  const isConnecting = connection.status === 'connecting';
  const hasError = connection.status === 'error';
  // Consider connected if status is connected OR syncing (to keep email visible during sync)
  const isEffectivelyConnected = isConnected || isSyncing;

  const handleCopyLink = () => {
    if (selectedEvent?.meetingLink) {
      navigator.clipboard.writeText(selectedEvent.meetingLink);
      toast.success('Link copiado!');
    }
  };

  const handleDelete = async () => {
    if (selectedEvent) {
      await deleteEvent(selectedEvent.id);
    }
  };

  const handleConnect = async () => {
    await connectGoogle();
    // Modal will close after redirect
  };

  const handleDisconnect = async () => {
    await disconnectGoogle();
  };

  if (isLoading) {
    return (
      <div className="page-container h-[calc(100vh-8rem)]">
        <div className="page-header">
          <div>
            <Skeleton className="h-8 w-32 mb-2" />
            <Skeleton className="h-4 w-48" />
          </div>
        </div>
        <Skeleton className="h-[calc(100%-80px)] w-full" />
      </div>
    );
  }

  return (
    <div className="page-container h-[calc(100vh-8rem)]">
      <div className="page-header">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-foreground">Agenda</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            {isConnected && connection.email
              ? `Sincronizado com ${connection.email}` 
              : hasError 
                ? 'Reconexão necessária'
                : 'Gerencie seus agendamentos'}
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          {!googleConfigured ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0" />
              <span>Google Calendar não configurado no servidor</span>
            </div>
          ) : !isEffectivelyConnected ? (
            <Button
              variant={hasError ? "destructive" : "outline"}
              size="sm"
              onClick={() => setShowConnectModal(true)}
              disabled={isConnecting}
            >
              {isConnecting ? (
                <>
                  <RefreshCw className="w-4 h-4 mr-2 animate-spin" />
                  Conectando...
                </>
              ) : hasError ? (
                <>
                  <AlertCircle className="w-4 h-4 mr-2" />
                  Reconectar
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Sincronizar
                </>
              )}
            </Button>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <Badge variant="outline" className="text-success border-success text-xs shrink-0">
                ✓ {connection.email}
              </Badge>
              <div className="flex items-center gap-2">
                <Button 
                  variant="outline" 
                  size="sm" 
                  onClick={syncNow} 
                  disabled={isSyncing}
                  title="Atualizar agora"
                >
                  <RefreshCw className={`w-4 h-4 mr-2 ${isSyncing ? 'animate-spin' : ''}`} />
                  Atualizar
                </Button>
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={handleDisconnect}
                  className="text-muted-foreground hover:text-destructive"
                >
                  Desconectar
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <CalendarView />

      {/* Google Connect Modal */}
      <GoogleConnectModal
        open={showConnectModal}
        onOpenChange={setShowConnectModal}
        onConnect={handleConnect}
      />

      {/* Event Details Sheet */}
      <Sheet open={!!selectedEvent} onOpenChange={(open) => !open && selectEvent(null)}>
        <SheetContent>
          {selectedEvent && (
            <>
              <SheetHeader>
                <div className="space-y-2">
                  <SheetTitle>{selectedEvent.title}</SheetTitle>
                  <Badge variant={selectedEvent.source === 'google' ? 'default' : 'secondary'}>
                    {selectedEvent.source === 'google' ? '🔵 Google Calendar' : '🟢 CRM'}
                  </Badge>
                </div>
              </SheetHeader>

              <div className="mt-6 space-y-6">
                {/* Data e Hora */}
                <div className="space-y-3">
                  <div className="flex items-center gap-3">
                    <Calendar className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    <span>{format(parseISO(selectedEvent.start), "dd 'de' MMMM, yyyy", { locale: ptBR })}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <Clock className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    <span>
                      {format(parseISO(selectedEvent.start), 'HH:mm')} - {format(parseISO(selectedEvent.end), 'HH:mm')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <MapPin className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    <span>{selectedEvent.location || 'Não informado'}</span>
                  </div>
                </div>

                {/* Google Meet */}
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <Link2 className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    <span className="font-medium">Google Meet</span>
                  </div>
                  {selectedEvent.meetingLink ? (
                    <>
                      <p className="text-sm text-muted-foreground ml-8 break-all">{selectedEvent.meetingLink}</p>
                      <div className="flex gap-2 ml-8">
                        <Button variant="outline" size="sm" onClick={handleCopyLink}>
                          <Copy className="w-3 h-3 mr-1" /> Copiar
                        </Button>
                        <Button variant="outline" size="sm" asChild>
                          <a href={selectedEvent.meetingLink} target="_blank" rel="noopener noreferrer">
                            <ExternalLink className="w-3 h-3 mr-1" /> Abrir
                          </a>
                        </Button>
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground ml-8">Nenhum link de reunião</p>
                  )}
                </div>

                {/* Participantes */}
                <div>
                  <h4 className="font-medium mb-2">Participantes</h4>
                  {selectedEvent.attendees.length > 0 ? (
                    <div className="space-y-2">
                      {selectedEvent.attendees.map((attendee, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-sm">
                          <User className="w-4 h-4 text-muted-foreground" />
                          <span>{attendee.name}</span>
                          <Badge variant="outline" className={attendee.status === 'confirmed' ? 'text-success border-success' : ''}>
                            {attendee.status === 'confirmed' ? '✓ Confirmado' : 
                             attendee.status === 'declined' ? '✗ Recusado' :
                             attendee.status === 'tentative' ? '? Talvez' : '⏳ Pendente'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nenhum participante</p>
                  )}
                </div>

                {/* Observações */}
                <div>
                  <h4 className="font-medium mb-2">Observações</h4>
                  <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                    {selectedEvent.notes || 'Nenhuma observação'}
                  </p>
                </div>

                {/* Actions */}
                {selectedEvent.source === 'crm' && (
                  <div className="pt-4 border-t">
                    <Button 
                      variant="destructive" 
                      size="sm" 
                      onClick={handleDelete}
                      className="w-full"
                    >
                      <Trash2 className="w-4 h-4 mr-2" />
                      Excluir evento
                    </Button>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
