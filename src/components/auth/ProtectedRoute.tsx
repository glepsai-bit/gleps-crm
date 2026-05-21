import { ReactNode, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { usePermissions } from '@/hooks/usePermissions';

type UserRole = 'super_admin' | 'admin' | 'agent';

interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
  requireSuperAdmin?: boolean;
}

export function ProtectedRoute({ 
  children, 
  allowedRoles,
  requireSuperAdmin = false,
}: ProtectedRouteProps) {
  const { isAuthenticated, user, isLoading } = useAuth();
  const { canAccessRoute, getFirstAllowedRoute } = usePermissions();
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated || !user) {
      navigate('/login', { state: { from: location }, replace: true });
      return;
    }

    if (requireSuperAdmin && user.role !== 'super_admin') {
      navigate('/unauthorized', { replace: true });
      return;
    }

    if (allowedRoles && !allowedRoles.includes(user.role)) {
      navigate('/unauthorized', { replace: true });
      return;
    }

    if (user.role === 'agent' && !canAccessRoute(location.pathname)) {
      navigate(getFirstAllowedRoute(), { replace: true });
    }
  }, [isLoading, isAuthenticated, user, requireSuperAdmin, allowedRoles, location.pathname, canAccessRoute, getFirstAllowedRoute, navigate]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-pulse flex flex-col items-center gap-4">
          <div className="h-12 w-12 rounded-full bg-primary/20" />
          <div className="h-4 w-32 bg-muted rounded" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return null;
  }

  if (requireSuperAdmin && user.role !== 'super_admin') {
    return null;
  }

  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return null;
  }

  if (user.role === 'agent' && !canAccessRoute(location.pathname)) {
    return null;
  }

  return <>{children}</>;
}

// Role-based redirect after login
export function getDefaultRoute(role: UserRole): string {
  switch (role) {
    case 'super_admin':
      return '/super-admin';
    case 'admin':
      return '/admin';
    case 'agent':
      return '/admin';
    default:
      return '/';
  }
}
