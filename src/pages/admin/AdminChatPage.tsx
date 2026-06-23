/**
 * AdminChatPage — T-022 Sprint 4 (Fase Frontend)
 *
 * Página principal do chat interno (paridade Chatwoot). Layout 3 colunas:
 *   - Esquerda  (320px): filtros + lista (ConversationList)
 *   - Centro    (flex):  thread (ConversationThread)
 *   - Direita   (320px): detalhes do contato (ContactSidePanel)
 *
 * No mobile, as colunas laterais viram drawers/popups acionados por botões
 * no header. O Socket.IO (namespace /chat) é conectado/desconectado com base
 * no JWT do usuário autenticado e join na conversa selecionada.
 */
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, Inbox as InboxIcon, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { tokenManager } from '@/api/client';
import { chatSocket } from '@/services/socket.client';
import { conversationsBackendService } from '@/services/conversations.backend.service';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { ConversationList } from '@/components/chat/ConversationList';
import { ConversationThread } from '@/components/chat/ConversationThread';
import { ContactSidePanel } from '@/components/chat/ContactSidePanel';

export default function AdminChatPage() {
  const { user, account } = useAuth();
  const queryClient = useQueryClient();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    null
  );
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [mobileContactOpen, setMobileContactOpen] = useState(false);

  // Conexão socket — depende do JWT do usuário logado.
  useEffect(() => {
    if (!user?.id) return;
    const token = tokenManager.getToken();
    if (!token) return;
    chatSocket.connect(token);
    return () => {
      chatSocket.disconnect();
    };
  }, [user?.id]);

  // Join/leave room conforme conversa selecionada + invalidação reativa.
  useEffect(() => {
    if (!selectedConversationId) return;
    chatSocket.joinConversation(selectedConversationId);

    const unsubMsg = chatSocket.onMessageCreated((payload) => {
      if (payload.conversationId === selectedConversationId) {
        queryClient.invalidateQueries({
          queryKey: ['conversation', selectedConversationId],
        });
      }
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });

    const unsubConv = chatSocket.onConversationUpdated((payload) => {
      queryClient.invalidateQueries({
        queryKey: ['conversation', payload.conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });

    const unsubAssigned = chatSocket.onAssigned((payload) => {
      queryClient.invalidateQueries({
        queryKey: ['conversation', payload.conversationId],
      });
      queryClient.invalidateQueries({ queryKey: ['conversations'] });
    });

    return () => {
      unsubMsg();
      unsubConv();
      unsubAssigned();
      chatSocket.leaveConversation(selectedConversationId);
    };
  }, [selectedConversationId, queryClient]);

  // Conversa selecionada (apenas para o ContactSidePanel — o thread carrega
  // por conta própria via [conversation, id]).
  const selectedConversationQuery = useQuery({
    queryKey: ['conversation', selectedConversationId],
    queryFn: () =>
      conversationsBackendService.getConversation(selectedConversationId!, {
        labels: true,
        participants: true,
      }),
    enabled: Boolean(selectedConversationId),
  });

  function handleSelectConversation(id: string) {
    setSelectedConversationId(id);
    setMobileListOpen(false);
  }

  if (!account?.id) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-8rem)] text-muted-foreground">
        Carregando conta...
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-2rem)] overflow-hidden">
      {/* Coluna esquerda — desktop */}
      <aside className="hidden lg:flex w-[320px] shrink-0">
        <ConversationList
          selectedConversationId={selectedConversationId}
          onSelectConversation={handleSelectConversation}
        />
      </aside>

      {/* Centro */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Mobile header (toggles drawers) */}
        <div className="lg:hidden flex items-center justify-between border-b border-border bg-card px-3 py-2">
          <Sheet open={mobileListOpen} onOpenChange={setMobileListOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8">
                <InboxIcon className="w-4 h-4 mr-1" />
                Conversas
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-[320px]">
              <ConversationList
                selectedConversationId={selectedConversationId}
                onSelectConversation={handleSelectConversation}
              />
            </SheetContent>
          </Sheet>

          {selectedConversationId && (
            <Sheet open={mobileContactOpen} onOpenChange={setMobileContactOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8">
                  <User className="w-4 h-4 mr-1" />
                  Contato
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="p-0 w-[320px]">
                {selectedConversationQuery.data && (
                  <ContactSidePanel conversation={selectedConversationQuery.data} />
                )}
              </SheetContent>
            </Sheet>
          )}
        </div>

        {selectedConversationId ? (
          <ConversationThread conversationId={selectedConversationId} />
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
            <MessageSquare className="w-12 h-12 mb-3 opacity-30" />
            <h2 className="text-lg font-semibold text-foreground">
              Selecione uma conversa
            </h2>
            <p className="text-sm mt-1 max-w-md">
              Escolha uma conversa na lista à esquerda para visualizar mensagens e
              interagir com o contato.
            </p>
          </div>
        )}
      </main>

      {/* Coluna direita — desktop */}
      <aside className="hidden lg:flex w-[320px] shrink-0">
        {selectedConversationQuery.data ? (
          <ContactSidePanel conversation={selectedConversationQuery.data} />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center border-l border-border bg-card text-muted-foreground p-4 text-center">
            <User className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-xs">Selecione uma conversa para ver o contato</p>
          </div>
        )}
      </aside>
    </div>
  );
}
