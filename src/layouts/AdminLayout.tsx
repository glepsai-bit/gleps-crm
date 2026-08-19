import { ReactNode, useState, useMemo, useCallback, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { chatSocket, type MentionPayload } from '@/services/socket.client';
import { agentAvailabilityBackendService } from '@/services/agent-availability.backend.service';
import { messagesBackendService } from '@/services/messages.backend.service';
import { tokenManager } from '@/api/client';
import { usePushNotifications } from '@/hooks/usePushNotifications';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  LayoutDashboard,
  Users,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  ArrowLeftRight,
  Kanban,
  DollarSign,
  Wallet,
  Package,
  Calendar,
  Crosshair,
  Mail,
  MessageSquare,
  Webhook,
  Ban,
  Bell,
  MessageCircle,
  BarChart3,
  Inbox,
  Zap,
  Settings2,
  Flame,
  Bot,
  BookOpen,
  UserCog,
  Radar,
} from 'lucide-react';
import { Logo } from '@/components/branding/Logo';
import { ThemeToggle } from '@/components/theme-toggle';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';

// ============================================
// Mapa de títulos por rota — esvaziado (BUG-ADMIN-PAGE-HEADER)
//
// Cada pagina admin renderiza seu PROPRIO header com titulo + acoes (ver
// AdminAgentesPage, AdminKanbanPage, etc). Manter aqui um titulo duplicado
// no AdminLayout causava:
//   1. Barra extra "Atendimento"/"Equipe"/"Kanban"/etc consumindo altura
//      util sem informacao nova (sidebar ja mostra item ativo).
//   2. Em paginas como /admin/chat, espremia o layout fullscreen.
//   3. Duplicidade visual confusa quando a pagina ja tem seu header.
//
// Mantemos o componente PageTitleHeader e o mapa para futura reutilizacao
// (ex: paginas que NAO tem header proprio, ou pra breadcrumb hierarquico).
// Para reativar em uma rota, basta adicionar a entrada aqui.
// ============================================
const routeTitles: Record<string, { title: string; parent?: { label: string; href: string } }> = {};

function PageTitleHeader({ pathname }: { pathname: string }) {
  const entry = routeTitles[pathname];
  if (!entry) return null;
  return (
    <div className="border-b border-border bg-background px-4 sm:px-6 py-2.5">
      {entry.parent ? (
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={entry.parent.href}>{entry.parent.label}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-semibold">{entry.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      ) : (
        <h1 className="text-sm font-semibold text-foreground">{entry.title}</h1>
      )}
    </div>
  );
}

interface AdminLayoutProps {
  children: ReactNode;
}

const adminNavItems = [
  // Atendimento (operação diária — topo)
  { title: 'Chat', href: '/admin/chat', icon: MessageCircle },
  { title: 'Dashboard Chat', href: '/admin/chat/dashboard', icon: BarChart3 },
  // Funil comercial
  { title: 'Kanban', href: '/admin/kanban', icon: Kanban },
  { title: 'Leads', href: '/admin/leads', icon: Users },
  { title: 'Agenda', href: '/admin/agenda', icon: Calendar },
  // Negócio
  { title: 'Vendas', href: '/admin/sales', icon: DollarSign },
  { title: 'Financeiro', href: '/admin/finance', icon: Wallet },
  { title: 'Produtos', href: '/admin/products', icon: Package },
  // Captação / marketing
  { title: 'Prospecção', href: '/admin/prospeccao', icon: Crosshair },
  { title: 'Tracking Ads', href: '/admin/tracking', icon: Radar },
  { title: 'E-mails', href: '/admin/emails', icon: Mail },
  { title: 'Templates WA', href: '/admin/whatsapp-templates', icon: MessageSquare },
  { title: 'Aquecimento', href: '/admin/warmup', icon: Flame },
  // T-027 — Atendimento IA (agentes + base de conhecimento)
  { title: 'Agentes IA', href: '/admin/ia/agentes', icon: Bot },
  { title: 'Conhecimento', href: '/admin/ia/conhecimento', icon: BookOpen },
  // Config do Chat (uso ocasional)
  { title: 'Inboxes', href: '/admin/inboxes', icon: Inbox },
  { title: 'Equipe', href: '/admin/agentes', icon: UserCog },
  { title: 'Times', href: '/admin/teams', icon: Users },
  { title: 'Respostas Rápidas', href: '/admin/canned-responses', icon: Zap },
  // SLA oculto por decisao do produto ("depois vemos isso"). Rotas/paginas/
  // service preservados no repo — reversivel. Ver App.tsx.
  { title: 'Atributos Custom', href: '/admin/custom-attributes', icon: Settings2 },
  { title: 'Opt-outs WA', href: '/admin/opt-outs', icon: Ban },
  { title: 'Integrações', href: '/admin/integracoes', icon: Webhook },
];

export default function AdminLayout({ children }: AdminLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, account, logout, isImpersonating, exitImpersonation } = useAuth();
  const { canAccessRoute } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();

  // Filter nav items based on user permissions
  const visibleNavItems = useMemo(() => {
    return adminNavItems.filter(item => canAccessRoute(item.href));
  }, [canAccessRoute]);

  const handleExitImpersonation = useCallback(() => {
    exitImpersonation();
    navigate('/super-admin');
  }, [exitImpersonation, navigate]);

  // ============================================
  // Socket.IO presence + mentions (T-022 Sprint 4)
  // ============================================
  // Lista de menções não lidas recebidas em tempo real (sino do header).
  const [mentions, setMentions] = useState<MentionPayload[]>([]);
  const [mentionsOpen, setMentionsOpen] = useState(false);

  // Web Push — registra service worker '/sw-push.js' + pede permissao Notification
  // + envia subscription VAPID pro backend. Hook eh guardado internamente contra
  // browser sem suporte / permissao negada / VAPID desabilitada no servidor,
  // entao aqui basta chamar com o userId autenticado.
  usePushNotifications(user?.id);

  // Conecta socket + marca online + heartbeat 30s enquanto autenticado.
  useEffect(() => {
    if (!user?.id) return;
    const token = tokenManager.getToken();
    if (!token) return;

    // Conecta no namespace /chat
    chatSocket.connect(token);

    // Marca status online no login (best-effort)
    agentAvailabilityBackendService
      .setMyStatus('online')
      .catch(() => { /* permissões podem negar p/ super_admin sem conta */ });

    // Heartbeat REST a cada 30s (mantém lastActiveAt e promove offline→online)
    const heartbeatInterval = setInterval(() => {
      agentAvailabilityBackendService.heartbeat().catch(() => {});
      // Heartbeat via socket também (não-bloqueante)
      try { chatSocket.sendHeartbeat(); } catch { /* ignore */ }
    }, 30_000);

    // Recebe menções em tempo real (acumula até o usuário ler)
    const offMention = chatSocket.onMention((payload) => {
      setMentions((prev) => {
        if (prev.some((m) => m.id === payload.id)) return prev;
        return [payload, ...prev].slice(0, 20);
      });
    });

    // T-022 Sprint 4 pareado: hidrata mentions não-lidas do backend logo
    // após conectar. Cobre o gap entre F5 e a chegada do primeiro socket
    // event — sem isso o sino ficava sempre em zero até uma menção nova
    // acontecer. GET /api/mentions?limit=20&read=false (default do controller).
    // AbortController evita setMentions após desmontar (troca de user).
    const mentionsCtrl = new AbortController();
    messagesBackendService
      .getMentions({ limit: 20 })
      .then((rows) => {
        if (mentionsCtrl.signal.aborted) return;
        const hydrated: MentionPayload[] = rows.map((r) => ({
          id: r.id,
          conversationId: r.conversationId,
          messageId: r.messageId ?? null,
          fromUserId: r.fromUserId ?? null,
          read: r.read,
          createdAt: r.createdAt,
        }));
        setMentions((prev) => {
          // Merge dedup: socket pode ter chegado antes do GET terminar.
          const seen = new Set(prev.map((m) => m.id));
          const merged = [...prev];
          for (const h of hydrated) {
            if (!seen.has(h.id)) {
              merged.push(h);
              seen.add(h.id);
            }
          }
          // Ordena por createdAt desc (mais recentes primeiro), limit 20.
          merged.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
          return merged.slice(0, 20);
        });
      })
      .catch(() => {
        /* silencioso — mentions não são críticas pro layout */
      });

    return () => {
      clearInterval(heartbeatInterval);
      offMention();
      mentionsCtrl.abort();
    };
  }, [user?.id]);

  const handleLogout = async () => {
    // Marca offline antes de derrubar o token (best-effort)
    try {
      await agentAvailabilityBackendService.setMyStatus('offline');
    } catch {
      /* ignore */
    }
    chatSocket.disconnect();
    await logout();
    navigate('/login');
  };

  function openMentionConversation(m: MentionPayload) {
    setMentions((prev) => prev.filter((x) => x.id !== m.id));
    setMentionsOpen(false);
    navigate(`/admin/chat?conversationId=${m.conversationId}`);
  }

  function clearMentions() {
    setMentions([]);
    setMentionsOpen(false);
  }

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Mobile Header - Safe area support */}
      <header className="lg:hidden fixed top-0 left-0 right-0 z-50 h-14 sm:h-16 border-b border-sidebar-border bg-sidebar px-3 sm:px-4 flex items-center justify-between safe-area-top">
        <div className="flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="p-2 sm:p-2.5 rounded-lg hover:bg-sidebar-accent text-sidebar-foreground touch-target"
            aria-label={mobileOpen ? 'Fechar menu' : 'Abrir menu'}
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <div className="flex items-center gap-2">
            <Logo variant="icon" className="w-6 h-6 sm:w-7 sm:h-7 text-sidebar-foreground" />
            <span className="font-semibold text-sidebar-foreground truncate max-w-[120px] xs:max-w-[150px] sm:max-w-[180px] text-sm sm:text-base">
              Gleps
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <MentionsBell
            count={mentions.length}
            open={mentionsOpen}
            onOpenChange={setMentionsOpen}
            mentions={mentions}
            onOpenMention={openMentionConversation}
            onClearAll={clearMentions}
            tone="sidebar"
          />
          <ThemeToggle className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground" />
        </div>
      </header>

      {/* Mobile Overlay — backdrop opaco + blur garante padrão drawer modal:
          conteúdo atrás não fica clicável (z-40 abaixo do sidebar z-50)
          e fica visualmente atenuado. aria-hidden pois é puro chrome. */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
          onClick={() => setMobileOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-50 h-screen bg-sidebar border-r border-sidebar-border transition-all duration-300 flex-col',
          collapsed ? 'w-[72px]' : 'w-64',
          'hidden lg:flex'
        )}
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-sidebar-border flex-shrink-0">
          {!collapsed && (
            <div className="flex items-center gap-2 overflow-hidden">
              <Logo variant="full" className="h-8 w-auto text-sidebar-foreground flex-shrink-0" />
            </div>
          )}
          {collapsed && (
            <Logo variant="icon" className="w-8 h-8 text-sidebar-foreground mx-auto" />
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'p-1.5 rounded-lg hover:bg-sidebar-accent text-sidebar-muted transition-colors',
              collapsed && 'mx-auto'
            )}
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>

        {/* Navigation - flex-1 + min-h-0 garante que o nav cresça e role,
            nunca sobrepondo o footer (Critical #7: viewport <800px). */}
        <ScrollArea className="flex-1 min-h-0">
          <nav className="p-3 space-y-1">
            {visibleNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                    isActive
                      ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent'
                  )}
                >
                  <item.icon className={cn('w-5 h-5 flex-shrink-0', collapsed && 'mx-auto')} />
                  {!collapsed && <span className="font-medium">{item.title}</span>}
                </Link>
              );
            })}
          </nav>
        </ScrollArea>

        {/* User Menu - footer no fim do flex-col, sem absolute */}
        <div className="flex-shrink-0 p-3 border-t border-sidebar-border space-y-1">
          <div
            className={cn(
              'flex items-center gap-1',
              collapsed ? 'justify-center' : 'justify-end'
            )}
          >
            <MentionsBell
              count={mentions.length}
              open={mentionsOpen}
              onOpenChange={setMentionsOpen}
              mentions={mentions}
              onOpenMention={openMentionConversation}
              onClearAll={clearMentions}
              tone="sidebar"
            />
            <ThemeToggle className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-lg hover:bg-sidebar-accent transition-colors min-w-0 overflow-hidden',
                  collapsed && 'justify-center'
                )}
                title={user?.nome}
              >
                <Avatar className="h-9 w-9 border-2 border-sidebar-primary shrink-0">
                  <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-sm">
                    {user ? getInitials(user.nome) : 'AD'}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="flex-1 min-w-0 text-left">
                    <p className="text-sm font-medium text-sidebar-foreground truncate">
                      {user?.nome}
                    </p>
                    <p className="text-xs text-sidebar-muted truncate">{user?.email}</p>
                  </div>
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Minha Conta</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {isImpersonating && (
                <>
                  <DropdownMenuItem onClick={handleExitImpersonation} className="text-warning">
                    <ArrowLeftRight className="w-4 h-4 mr-2" />
                    Sair da Impersonação
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onClick={handleLogout}
                className="text-destructive dark:text-red-300 focus:text-destructive dark:focus:text-red-300"
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Mobile Sidebar - flex-col garante que footer "Sair" nunca cubra itens */}
      <aside
        className={cn(
          'lg:hidden fixed top-14 sm:top-16 left-0 z-50 h-[calc(100vh-3.5rem)] sm:h-[calc(100vh-4rem)] w-[75vw] xs:w-64 bg-sidebar border-r border-sidebar-border transition-transform duration-300 safe-area-bottom flex flex-col',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <ScrollArea className="flex-1 min-h-0">
          <nav className="p-3 space-y-1">
            {visibleNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => setMobileOpen(false)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex items-center justify-start gap-3 px-4 py-3 rounded-lg transition-all touch-target text-left',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
                    isActive
                      ? 'bg-sidebar-primary text-sidebar-primary-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent'
                  )}
                >
                  <item.icon className="w-5 h-5 flex-shrink-0" />
                  <span className="font-medium">{item.title}</span>
                </Link>
              );
            })}
          </nav>
        </ScrollArea>
        <div className="flex-shrink-0 p-3 border-t border-sidebar-border safe-area-bottom">
          <Button
            onClick={handleLogout}
            variant="ghost"
            className="w-full justify-start text-red-300 hover:text-red-200 hover:bg-sidebar-accent min-h-[44px]"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sair
          </Button>
        </div>
      </aside>

      {/* Main Content - usa token de tema (claro/escuro).
          BUG-CHAT-GAP-DIREITA: `overflow-x-hidden` impede que qualquer pagina
          interna (ex: chat com calc(100vh-Xrem) levemente errado) cause
          scrollbar VERTICAL no body, que comeria 15px de largura util e
          deixaria gap a direita do painel Contato. overflow-x apenas — overflow-y
          permanece auto pra paginas longas (kanban, leads, etc). */}
      <main
        className={cn(
          'transition-all duration-300 min-h-screen bg-background overflow-x-hidden',
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-64',
          'pt-14 sm:pt-16 lg:pt-0'
        )}
      >
        {isImpersonating && (
          <div className="bg-warning/10 border-b border-warning/30 px-3 sm:px-4 py-2">
            <div className="flex flex-col xs:flex-row items-center justify-center gap-1 xs:gap-2 text-xs sm:text-sm text-warning">
              <div className="flex items-center gap-1.5">
                <ArrowLeftRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                <span>
                  Visualizando como <strong className="truncate max-w-[100px] inline-block align-bottom">{user?.nome}</strong>
                </span>
              </div>
              <button onClick={handleExitImpersonation} className="underline hover:no-underline whitespace-nowrap">
                Sair
              </button>
            </div>
          </div>
        )}
        <PageTitleHeader pathname={location.pathname} />
        {children}
      </main>
    </div>
  );
}

// ============================================
// MentionsBell — sino do header com badge de menções não lidas (T-022)
// ============================================
interface MentionsBellProps {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mentions: MentionPayload[];
  onOpenMention: (m: MentionPayload) => void;
  onClearAll: () => void;
  tone?: 'sidebar' | 'default';
}

function MentionsBell({
  count,
  open,
  onOpenChange,
  mentions,
  onOpenMention,
  onClearAll,
  tone = 'default',
}: MentionsBellProps) {
  const triggerCls = cn(
    'relative p-2 rounded-lg transition-colors touch-target',
    tone === 'sidebar'
      ? 'text-sidebar-foreground hover:bg-sidebar-accent'
      : 'text-foreground hover:bg-accent'
  );

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerCls}
          aria-label={count > 0 ? `${count} menções não lidas` : 'Menções'}
        >
          <Bell className="w-5 h-5" />
          {count > 0 && (
            <Badge
              className="absolute -top-0.5 -right-0.5 h-4 min-w-[16px] px-1 text-[10px] bg-destructive text-destructive-foreground border-0"
            >
              {count > 9 ? '9+' : count}
            </Badge>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold uppercase text-muted-foreground">
            Menções
          </p>
          {mentions.length > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="text-[11px] text-muted-foreground hover:text-foreground"
            >
              Limpar
            </button>
          )}
        </div>
        {mentions.length === 0 ? (
          <p className="text-xs text-muted-foreground py-3 text-center">
            Sem menções novas
          </p>
        ) : (
          <div className="space-y-1 max-h-80 overflow-y-auto">
            {mentions.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => onOpenMention(m)}
                className="w-full text-left rounded px-2 py-1.5 text-xs hover:bg-accent"
              >
                <p className="font-medium truncate">
                  Nova menção em conversa
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {m.createdAt
                    ? new Date(m.createdAt).toLocaleString('pt-BR')
                    : 'agora'}
                </p>
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}