import { ReactNode, useState, useCallback } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  Building2,
  Users,
  LogOut,
  ChevronLeft,
  ChevronRight,
  Menu,
  X,
  ArrowLeftRight,
} from 'lucide-react';
import mychooiceLogo from '@/assets/mychooice-logo-white.svg';

interface SidebarLayoutProps {
  children: ReactNode;
}

const superAdminNavItems = [
  { title: 'Dashboard', href: '/super-admin', icon: LayoutDashboard },
  { title: 'Contas', href: '/super-admin/accounts', icon: Building2 },
  { title: 'Usuários', href: '/super-admin/users', icon: Users },
];

export default function SuperAdminLayout({ children }: SidebarLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { user, logout, isImpersonating, exitImpersonation } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const handleExitImpersonation = useCallback(() => {
    exitImpersonation();
    navigate('/super-admin');
  }, [exitImpersonation, navigate]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

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
            <img src={mychooiceLogo} alt="MyChooice" className="w-6 h-6 sm:w-7 sm:h-7 object-contain" />
            <span className="font-semibold text-sidebar-foreground text-sm sm:text-base">GoodLeads Admin</span>
          </div>
        </div>
      </header>

      {/* Mobile Overlay */}
      {mobileOpen && (
        <div
          className="lg:hidden fixed inset-0 z-40 bg-black/50"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed top-0 left-0 z-50 h-full bg-sidebar border-r border-sidebar-border transition-all duration-300',
          collapsed ? 'w-[72px]' : 'w-64',
          'hidden lg:block'
        )}
      >
        {/* Logo */}
        <div className="h-16 flex items-center justify-between px-4 border-b border-sidebar-border">
          {!collapsed && (
            <div className="flex items-center gap-2">
              <img src={mychooiceLogo} alt="MyChooice" className="w-8 h-8 object-contain" />
              <span className="font-bold text-lg text-sidebar-foreground">GoodLeads Admin</span>
            </div>
          )}
          {collapsed && (
            <img src={mychooiceLogo} alt="MyChooice" className="w-8 h-8 object-contain mx-auto" />
          )}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={cn(
              'p-1.5 rounded-lg hover:bg-sidebar-accent text-sidebar-muted transition-colors',
              collapsed && 'mx-auto'
            )}
          >
            {collapsed ? (
              <ChevronRight className="w-4 h-4" />
            ) : (
              <ChevronLeft className="w-4 h-4" />
            )}
          </button>
        </div>

        {/* Navigation */}
        <ScrollArea className="h-[calc(100vh-8rem)]">
          <nav className="p-3 space-y-1">
            {superAdminNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all',
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

        {/* User Menu */}
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-sidebar-border">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                className={cn(
                  'w-full flex items-center gap-3 p-2 rounded-lg hover:bg-sidebar-accent transition-colors',
                  collapsed && 'justify-center'
                )}
              >
                <Avatar className="h-9 w-9 border-2 border-sidebar-primary">
                  <AvatarFallback className="bg-sidebar-primary text-sidebar-primary-foreground text-sm">
                    {user ? getInitials(user.nome) : 'SA'}
                  </AvatarFallback>
                </Avatar>
                {!collapsed && (
                  <div className="flex-1 text-left">
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
              <DropdownMenuItem onClick={handleLogout} className="text-destructive">
                <LogOut className="w-4 h-4 mr-2" />
                Sair
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      {/* Mobile Sidebar */}
      <aside
        className={cn(
          'lg:hidden fixed top-14 sm:top-16 left-0 z-50 h-[calc(100vh-3.5rem)] sm:h-[calc(100vh-4rem)] w-[75vw] xs:w-64 bg-sidebar border-r border-sidebar-border transition-transform duration-300 safe-area-bottom',
          mobileOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <ScrollArea className="h-[calc(100%-5rem)]">
          <nav className="p-3 space-y-1">
            {superAdminNavItems.map((item) => {
              const isActive = location.pathname === item.href;
              return (
                <Link
                  key={item.href}
                  to={item.href}
                  onClick={() => setMobileOpen(false)}
                  className={cn(
                    'flex items-center justify-start gap-3 px-4 py-3 rounded-lg transition-all touch-target text-left',
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
        <div className="absolute bottom-0 left-0 right-0 p-3 border-t border-sidebar-border safe-area-bottom">
          <Button onClick={handleLogout} variant="ghost" className="w-full justify-start text-destructive min-h-[44px]">
            <LogOut className="w-4 h-4 mr-2" />
            Sair
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main
        className={cn(
          'transition-all duration-300 min-h-screen bg-white',
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
              <button
                onClick={handleExitImpersonation}
                className="underline hover:no-underline whitespace-nowrap"
              >
                Sair
              </button>
            </div>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}