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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { VisuallyHidden } from '@radix-ui/react-visually-hidden';
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

  // BUG-CHAT-GAP-DIREITA (Chatwoot-style fix, T-022/4):
  //
  // Bug reportado pelo user multiplas vezes: painel direito 'Contato' deixava
  // espaco branco a direita do viewport. Causa raiz: container raiz era
  // `<div className="flex h-[calc(100vh-2rem)] overflow-hidden">` SEM
  // `w-full`. Em DIVs block isso normalmente herda 100% do pai, MAS qualquer
  // intermediario (PageTitleHeader, animation transition do AdminLayout,
  // padding herdado) podia desalinhar a largura final.
  //
  // Fix Chatwoot-style:
  //  1. `w-full` explicito no container raiz (defesa contra herancas)
  //  2. CSS Grid 3-colunas (auto 1fr auto) em vez de flex — grid forca
  //     a soma 100% sempre, sem ambiguidade de min-content
  //  3. `min-w-0` em todas colunas pra impedir overflow-to-right
  //
  // Em <xl reduz pra grid 2-col (lista + thread); em <lg vira 1-col fluido
  // controlado pelas classes `hidden`/`flex` ja existentes.
  return (
    <div className="grid w-full h-[calc(100vh-4rem)] lg:h-dvh overflow-hidden grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[360px_minmax(0,1fr)_320px]">
      {/* Coluna esquerda — lista de conversas.
          BUG-CRIT-4: em <lg ocupa a largura inteira (w-full) e so aparece
          quando nao ha conversa selecionada. Em lg+ volta a ser uma coluna
          fixa de 320px sempre visivel.
          BUG-CHAT-GAP-DIREITA: removido `lg:w-[320px]` — a largura agora vem
          do grid-template-columns do pai (mais robusto). */}
      <aside
        className={cn(
          'min-w-0 overflow-hidden lg:flex lg:w-[360px]',
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
        {/* Header com botao "Contato" a direita. Aparece em <xl (ate 1279px):
            inclui mobile (<lg), tablet/laptop pequeno (lg..xl-1) onde o
            painel de contato fixo nao cabe e vira drawer (Sheet).
            BUG-CHAT-RESPONSIVE: antes era `lg:hidden` (so <1024). Em laptops
            de 1024-1279 o aside direito de 320px tambem aparecia ao mesmo
            tempo da lista (320) + sidebar nav (256), espremendo a thread
            para ~113px de largura util — bubbles quebravam em colunas de
            1-2 chars e davam a impressao de que "as mensagens sumiram".
            Subindo o breakpoint do aside direito para xl (>=1280) e
            mostrando o botao Contato ate xl-1 mantemos 2 colunas saudaveis
            no laptop. O botao Conversas/voltar fica dentro do header da
            propria ConversationThread via prop `onBack` (lg:hidden la). */}
        {selectedConversationId && (
          <div className="xl:hidden flex items-center justify-end border-b border-border bg-card px-3 py-1">
            <Sheet open={mobileContactOpen} onOpenChange={setMobileContactOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="sm" className="h-8">
                  <User className="w-4 h-4 mr-1" />
                  Contato
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="p-0 w-[320px]">
                {/* NIT-1314-02: DialogTitle obrigatorio pra acessibilidade (Radix
                    requirement). VisuallyHidden esconde visualmente mas mantem
                    no screen reader. Sem isso, console emite warning a11y. */}
                <VisuallyHidden>
                  <SheetTitle>Detalhes do contato</SheetTitle>
                </VisuallyHidden>
                {selectedConversationQuery.data && (
                  <ContactSidePanel
                    conversation={selectedConversationQuery.data}
                    onClose={() => setMobileContactOpen(false)}
                  />
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

      {/* Coluna direita — desktop largo somente (>=xl/1280px). Em mobile,
          tablet e laptop pequeno (<1280) o painel de contato vira drawer
          acionado pelo botao "Contato" no header acima.
          BUG-CHAT-RESPONSIVE: antes era `lg:flex` (>=1024). Em 1024-1279
          a soma 256 (nav) + 320 (lista) + 320 (este aside) deixava apenas
          ~128px para a thread, esmagando os bubbles. Em xl (>=1280) ja sobra
          espaco para 3 colunas confortaveis.
          BUG-CHAT-OVERFLOW: `min-w-0 overflow-hidden` aplicado pelo mesmo
          motivo do aside esquerdo — defesa contra crescimento do min-content. */}
      <aside className="hidden xl:flex xl:w-[320px] min-w-0 overflow-hidden">
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
