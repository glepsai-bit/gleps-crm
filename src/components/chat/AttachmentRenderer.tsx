/**
 * AttachmentRenderer — T-022 Sprint 4 (chat interno) + Bug A
 *
 * Renderiza um Attachment do model `Message` conforme `fileType` / `mimeType`.
 *
 * Bug A: o backend agora serve mídia via /api/attachments/<id> (autenticado).
 * Como image/video/audio nativos não suportam Authorization header em request
 * de mídia, usamos o hook useAuthenticatedBlobUrl pra buscar e expor um blob URL
 * (ou cair em src direto pra URLs absolutas legadas).
 */
import { useEffect, useState } from 'react';
import { Download, FileText, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AudioPlayer } from '@/components/chat/AudioPlayer';
import { tokenManager } from '@/api/client';
import type { Attachment } from '@/services/conversations.backend.service';

interface AttachmentRendererProps {
  attachment: Attachment;
}

function humanFileSize(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function isProxyUrl(src: string): boolean {
  return /^\/?api\/attachments\//.test(src);
}

/**
 * Hook: se src é o proxy autenticado, baixa com Bearer e devolve blob URL.
 * Caso contrário (URL pública/legacy), retorna src direto.
 */
function useAuthenticatedSrc(src: string): { resolvedSrc: string | null; loading: boolean; error: boolean } {
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(
    isProxyUrl(src) ? null : src
  );
  const [loading, setLoading] = useState<boolean>(isProxyUrl(src));
  const [error, setError] = useState<boolean>(false);

  useEffect(() => {
    if (!isProxyUrl(src)) {
      setResolvedSrc(src);
      setLoading(false);
      setError(false);
      return;
    }

    let cancelled = false;
    let createdUrl: string | null = null;
    setLoading(true);
    setError(false);
    setResolvedSrc(null);

    const token = tokenManager.getToken();
    const url = src.startsWith('/') ? src : `/${src}`;

    fetch(url, {
      method: 'GET',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (cancelled) return;
        createdUrl = URL.createObjectURL(blob);
        setResolvedSrc(createdUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  return { resolvedSrc, loading, error };
}

export function AttachmentRenderer({ attachment }: AttachmentRendererProps) {
  const { fileType, fileUrl, fileName, thumbnailUrl, mimeType, fileSize } = attachment;
  const displayName = fileName || fileUrl.split('/').pop() || 'arquivo';

  // áudio tem player próprio que já faz fetch+blob
  if (fileType === 'audio') {
    return <AudioPlayer src={fileUrl} mimeType={mimeType} />;
  }

  if (fileType === 'image') {
    return <ImageAttachment fileUrl={fileUrl} thumbnailUrl={thumbnailUrl} displayName={displayName} />;
  }

  // Sticker (WEBP) — recebimento apenas. Render menor (~180x180) sem bordas
  // pra parecer figurinha nativa. Sem lightbox nem link — sticker nao eh
  // pra download. WEBP animado toca automatico via tag <img> nativa.
  if (fileType === 'sticker') {
    return <StickerAttachment fileUrl={fileUrl} displayName={displayName} />;
  }

  if (fileType === 'video') {
    return <VideoAttachment fileUrl={fileUrl} thumbnailUrl={thumbnailUrl} mimeType={mimeType} />;
  }

  // document e fallback — link href; o browser dispara o GET com Bearer
  // (não direto, no GET de download a auth header não é enviada — então
  // usamos onClick que faz fetch+blob+download manual).
  return (
    <DocumentAttachment fileUrl={fileUrl} displayName={displayName} fileSize={fileSize} />
  );
}

function ImageAttachment({
  fileUrl,
  thumbnailUrl,
  displayName,
}: { fileUrl: string; thumbnailUrl?: string | null; displayName: string }) {
  const main = useAuthenticatedSrc(fileUrl);
  const thumb = useAuthenticatedSrc(thumbnailUrl || fileUrl);
  const src = thumb.resolvedSrc || main.resolvedSrc;
  const href = main.resolvedSrc || src || '#';
  if ((thumb.loading && main.loading) || (!src && !main.error)) {
    return (
      <div className="flex items-center justify-center w-[260px] h-32 rounded-md border border-border bg-muted/40">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (main.error && !src) {
    return (
      <div className="w-[260px] rounded-md border border-destructive/40 bg-destructive/5 px-3 py-6 text-center text-xs text-destructive">
        Falha ao carregar imagem
      </div>
    );
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="block max-w-[260px] rounded-md overflow-hidden border border-border bg-muted"
    >
      <img
        src={src || ''}
        alt={displayName}
        loading="lazy"
        className="w-full h-auto object-cover max-h-64"
      />
    </a>
  );
}

function StickerAttachment({
  fileUrl,
  displayName,
}: { fileUrl: string; displayName: string }) {
  const { resolvedSrc, loading, error } = useAuthenticatedSrc(fileUrl);
  if (loading || !resolvedSrc) {
    return (
      <div className="flex items-center justify-center w-[160px] h-[160px] rounded-md bg-transparent">
        <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="w-[160px] rounded-md border border-destructive/40 bg-destructive/5 px-3 py-4 text-center text-xs text-destructive">
        Sticker
      </div>
    );
  }
  return (
    <img
      src={resolvedSrc}
      alt={displayName}
      className="w-[160px] h-[160px] object-contain select-none"
      draggable={false}
    />
  );
}

function VideoAttachment({
  fileUrl,
  thumbnailUrl,
  mimeType,
}: { fileUrl: string; thumbnailUrl?: string | null; mimeType?: string | null }) {
  const main = useAuthenticatedSrc(fileUrl);
  const poster = useAuthenticatedSrc(thumbnailUrl || '');
  if (main.loading && !main.resolvedSrc) {
    return (
      <div className="flex items-center justify-center w-[260px] h-40 rounded-md border border-border bg-black/80">
        <Loader2 className="w-5 h-5 animate-spin text-white/80" />
      </div>
    );
  }
  if (main.error || !main.resolvedSrc) {
    return (
      <div className="w-[260px] rounded-md border border-destructive/40 bg-destructive/5 px-3 py-6 text-center text-xs text-destructive">
        Falha ao carregar vídeo
      </div>
    );
  }
  return (
    <video
      controls
      preload="metadata"
      poster={poster.resolvedSrc || undefined}
      className="max-w-[260px] rounded-md border border-border bg-black"
    >
      <source src={main.resolvedSrc} type={mimeType || 'video/mp4'} />
      Seu navegador não suporta o player de vídeo.
    </video>
  );
}

function DocumentAttachment({
  fileUrl,
  displayName,
  fileSize,
}: { fileUrl: string; displayName: string; fileSize?: number | null }) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async (e: React.MouseEvent) => {
    if (!isProxyUrl(fileUrl)) return; // deixa o anchor lidar (URL pública)
    e.preventDefault();
    if (downloading) return;
    setDownloading(true);
    try {
      const token = tokenManager.getToken();
      const url = fileUrl.startsWith('/') ? fileUrl : `/${fileUrl}`;
      const res = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error('falha download');
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = displayName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // microtask: permite o browser começar o download antes do revoke
      setTimeout(() => URL.revokeObjectURL(objectUrl), 4000);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <a
      href={fileUrl}
      download={displayName}
      onClick={handleDownload}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-2 max-w-[260px] rounded-md border border-border bg-muted/40 px-3 py-2 hover:bg-muted transition-colors"
    >
      <FileText className="w-4 h-4 shrink-0 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium truncate text-foreground">{displayName}</p>
        {fileSize ? (
          <p className="text-[10px] text-muted-foreground">{humanFileSize(fileSize)}</p>
        ) : null}
      </div>
      <Button asChild variant="ghost" size="icon" className="h-6 w-6 shrink-0">
        <span>
          {downloading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        </span>
      </Button>
    </a>
  );
}

export default AttachmentRenderer;
