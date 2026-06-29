/**
 * AdminChatPage — T-022 Sprint 4 (Fase Frontend)
 *
 * Página principal do chat interno. Layout 3 colunas:
 *   - Esquerda  (320px): filtros + lista (ConversationList)
 *   - Centro    (flex):  thread (ConversationThread)
 *   - Direita   (320px): detalhes do contato (ContactSidePanel)
 *
 * No mobile, as colunas laterais viram drawers/popups acionados por botões
 * no header. O Socket.IO (namespace /chat) é conectado/desconectado com base
 * no JWT do usuário autenticado e join na conversa selecionada.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, User } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { conversationsBackendService } from '@/services/conversations.backend.service';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ConversationList } from '@/components/chat/ConversationList';
import { ConversationThread } from '@/components/chat/ConversationThread';
import { ContactSidePanel } from '@/components/chat/ContactSidePanel';

export default function AdminChatPage() {
  const { account } = useAuth();
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    null
  );
  const [mobileContactOpen, setMobileContactOpen] = useState(false);

  // OBS sobre Socket.IO (T-022 / BUG-4):
  //
  //  - connect/disconnect é de propriedade do AdminLayout (lifecycle global).
  //    Se chamássemos disconnect() aqui no cleanup ao desmontar a página,
  //    derrubaríamos o listener de menções (sino do header) e os listeners
  //    de ConversationList — eles só re-conectam quando outro componente
  //    chama connect() novamente.
  //
  //  - join/leave da sala da conversa é de propriedade do ConversationThread,
  //    que já entra no `chatSocket.joinConversation(conversationId)` dentro do
  //    seu próprio useEffect com dependência [conversationId]. Joinar aqui
  //    também causava duplicidade de eventos (o servidor mantém em room por
  //    socket, mas o cliente registrava callbacks redundantes).
  //
  //  - Listeners onMessageCreated/onConversationUpdated/onAssigned ficam
  //    APENAS no ConversationThread (escopo: thread aberta) e ConversationList
  //    (escopo: lista lateral). Registrar aqui também causava 2-3
  //    invalidateQueries no MESMO queryKey por evento, disparando refetches
  //    simultâneos. O "último ganha" zerava a thread (Bug 3 — "Nenhuma
  //    mensagem ainda" piscando) e a mensagem própria do agente só aparecia
  //    depois do refetch tardio (Bug 1 — delay no envio). A oscilação do
  //    nome do contato (Bug 2) também caía nessa categoria: a query do
  //    sidepanel e a do thread compartilhavam queryKey ['conversation', id]
  //    e a resposta mais leve sobrescrevia a mais completa. Por isso o key
  //    abaixo agora tem o sufixo 'meta'.

  // Conversa selecionada (apenas para o ContactSidePanel — o thread carrega
  // por conta própria via ['conversation', id, 'thread-full'] em
  // ConversationThread).
  //
  // BUG-3: QueryKey isolado por intenção: 'sidepanel-meta' (SEM messages) vs
  // 'thread-full' (COM messages). Sem isolar, as duas queries dividiam a
  // mesma entrada de cache ['conversation', id]: o pai (sidepanel) pedia
  // sem `messages` e podia sobrescrever a resposta do filho que vinha COM
  // messages, zerando a thread momentaneamente ("Nenhuma mensagem ainda"
  // piscando no meio da conversa). Quem precisa invalidar AMBAS as
  // variantes deve usar predicate-based invalidation:
  //   queryClient.invalidateQueries({
  //     predicate: q => q.queryKey[0] === 'conversation' && q.queryKey[1] === id
  //   })
  const selectedConversationQuery = useQuery({
    queryKey: ['conversation', selectedConversationId, 'sidepanel-meta'],
    queryFn: () =>
      conversationsBackendService.getConversation(selectedConversationId!, {
        labels: true,
        participants: true,
      }),
    enabled: Boolean(selectedConversationId),
    // BUG-MSG-GHOST: shape invariante mesmo no sidepanel — labels e
    // participants sempre array. Backend ja garante (stripHeavyRelations
    // + GET `out.messages/labels/participants = []` default), mas aqui é a
    // ultima linha de defesa contra payload antigo / CDN cacheado.
    select: (data) => ({
      ...data,
      labels: Array.isArray(data?.labels) ? data.labels : [],
      participants: Array.isArray(data?.participants) ? data.participants : [],
    }),
  });

  function handleSelectConversation(id: string) {
    // BUG-CRIT-4: ao selecionar uma conversa em mobile, o `selectedConversationId`
    // troca o que esta renderizado: lista some, thread aparece (via classes
    // condicionais no JSX abaixo). Em desktop o efeito visual e so destacar
    // a conversa selecionada na lista lateral (que permanece visivel).
    setSelectedConversationId(id);
  }

  function handleBackToList() {
    // BUG-CRIT-4: callback do botao "Voltar" na thread em mobile.
    // Limpa a selecao e o JSX condicional volta a renderizar a lista.
    setSelectedConversationId(null);
  }

  if (!account?.id) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-8rem)] text-muted-foreground">
        Carregando conta...
      </div>
    );
  }

  // BUG-CRIT-4: helpers de visibilidade mobile.
  // Em <lg: alterna lista <-> thread baseado em `selectedConversationId`.
  //   - sem selecao: lista visivel, thread escondida.
  //   - com selecao: thread visivel, lista escondida + botao "Voltar".
  // Em lg+: ambos sempre visiveis lado a lado (como antes).
  const showListOnMobile = !selectedConversationId;
  const showThreadOnMobile = Boolean(selectedConversationId);

  return (
    <div className="flex h-[calc(100vh-4rem)] lg:h-[calc(100vh-2rem)] overflow-hidden">
      {/* Coluna esquerda — lista de conversas.
          BUG-CRIT-4: em <lg ocupa a largura inteira (w-full) e so aparece
          quando nao ha conversa selecionada. Em lg+ volta a ser uma coluna
          fixa de 320px sempre visivel. */}
      {/* BUG-CHAT-OVERFLOW: `min-w-0 overflow-hidden` no aside impede que o
          filho cresca ate o min-content (~412px) e estoure os 320px de
          `lg:w-[320px]`, sobrepondo a thread do meio. O culpado eh o grid
          2-colunas dos Selects do header (cada SelectTrigger ~190px). O
          ConversationList ja foi atualizado para usar `w-full min-w-0`
          como ultima linha de defesa. */}
      <aside
        className={cn(
          'shrink-0 min-w-0 overflow-hidden lg:w-[320px] lg:flex',
          // Mobile: lista ocupa tela inteira quando nada selecionado;
          // some quando ha conversa aberta (a thread toma o lugar).
          // Em lg+ o `lg:flex` acima reativa, mantendo lado a lado.
          showListOnMobile ? 'flex w-full' : 'hidden'
        )}
      >
        <ConversationList
          selectedConversationId={selectedConversationId}
          onSelectConversation={handleSelectConversation}
        />
      </aside>

      {/* Centro — thread.
          BUG-CRIT-4: em <lg fica oculto quando nao ha conversa selecionada
          (a lista ocupa a tela inteira). Em lg+ esta sempre presente. */}
      <main
        className={cn(
          'flex-1 flex-col min-w-0 lg:flex',
          showThreadOnMobile ? 'flex' : 'hidden'
        )}
      >
        {/* Mobile header (botao Contato a direita). O botao Conversas/voltar
            fica dentro do header da propria ConversationThread via prop
            `onBack` — assim a transicao volta-pra-lista vira parte do
            cabecalho da conversa em si. */}
        {selectedConversationId && (
          <div className="lg:hidden flex items-center justify-end border-b border-border bg-card px-3 py-1">
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
          </div>
        )}

        {selectedConversationId ? (
          <ConversationThread
            conversationId={selectedConversationId}
            onBack={handleBackToList}
          />
        ) : (
          // Placeholder exibido apenas em desktop (lg+) quando nada esta
          // selecionado. Em mobile esse ramo nunca renderiza porque o
          // <main> esta hidden quando showThreadOnMobile = false.
          <div className="flex-1 hidden lg:flex flex-col items-center justify-center text-muted-foreground p-6 text-center">
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

      {/* Coluna direita — desktop somente (em mobile o painel de contato vira
          drawer acionado pelo botao "Contato" no header acima).
          BUG-CHAT-OVERFLOW: `min-w-0 overflow-hidden` aplicado pelo mesmo
          motivo do aside esquerdo — defesa contra crescimento do min-content. */}
      <aside className="hidden lg:flex w-[320px] shrink-0 min-w-0 overflow-hidden">
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
