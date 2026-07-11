/**
 * AUDIT-AVATAR: AvatarImage que sabe carregar /api/contacts/:id/avatar
 * (endpoint autenticado — <img src> puro tomaria 401). URLs externas/data
 * passam direto. Cache em memória evita refetch por card da lista.
 */
import { useEffect, useState } from 'react';
import { AvatarImage } from '@/components/ui/avatar';
import { tokenManager } from '@/api/client';

const objectUrlCache = new Map<string, string>();

function useAuthenticatedImage(src: string | null | undefined): string | null {
  const isApi = Boolean(src && src.startsWith('/api/'));
  const [resolved, setResolved] = useState<string | null>(() => {
    if (!src) return null;
    if (!isApi) return src;
    return objectUrlCache.get(src) ?? null;
  });

  useEffect(() => {
    if (!src) {
      setResolved(null);
      return;
    }
    if (!src.startsWith('/api/')) {
      setResolved(src);
      return;
    }
    const cached = objectUrlCache.get(src);
    if (cached) {
      setResolved(cached);
      return;
    }
    let cancelled = false;
    const token = tokenManager.getToken();
    fetch(src, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error(`status ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        objectUrlCache.set(src, url);
        setResolved(url);
      })
      .catch(() => {
        if (!cancelled) setResolved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [src, isApi]);

  return resolved;
}

export function AuthAvatarImage({
  src,
  alt,
}: {
  src: string | null | undefined;
  alt?: string;
}) {
  const resolved = useAuthenticatedImage(src);
  // null mantém o AvatarFallback do Radix (inicial do nome).
  if (!resolved) return null;
  return <AvatarImage src={resolved} alt={alt} />;
}
