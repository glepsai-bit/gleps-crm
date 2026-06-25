/**
 * AttachmentRenderer — T-022 Sprint 4 (chat interno)
 *
 * Renderiza um Attachment do model `Message` de acordo com `fileType` /
 * `mimeType`. Mantém o markup simples (sem libs de player) — preview inline
 * para image/video/audio e download fallback para documents.
 */
import { Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AudioPlayer } from '@/components/chat/AudioPlayer';
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

export function AttachmentRenderer({ attachment }: AttachmentRendererProps) {
  const { fileType, fileUrl, fileName, thumbnailUrl, mimeType, fileSize } = attachment;
  const displayName = fileName || fileUrl.split('/').pop() || 'arquivo';

  if (fileType === 'image') {
    return (
      <a
        href={fileUrl}
        target="_blank"
        rel="noreferrer"
        className="block max-w-[260px] rounded-md overflow-hidden border border-border bg-muted"
      >
        <img
          src={thumbnailUrl || fileUrl}
          alt={displayName}
          loading="lazy"
          className="w-full h-auto object-cover max-h-64"
        />
      </a>
    );
  }

  if (fileType === 'video') {
    return (
      <video
        controls
        preload="metadata"
        poster={thumbnailUrl || undefined}
        className="max-w-[260px] rounded-md border border-border bg-black"
      >
        <source src={fileUrl} type={mimeType || 'video/mp4'} />
        Seu navegador não suporta o player de vídeo.
      </video>
    );
  }

  if (fileType === 'audio') {
    return <AudioPlayer src={fileUrl} mimeType={mimeType} />;
  }

  // document e fallback
  return (
    <a
      href={fileUrl}
      download={displayName}
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
          <Download className="w-3 h-3" />
        </span>
      </Button>
    </a>
  );
}

export default AttachmentRenderer;
