/**
 * AudioPlayer — T-022 BUG-5 / Bug A
 *
 * Player de áudio custom estilizado (verde primary) — substitui o
 * <audio controls /> nativo (UX pobre, visual quebrado em dark mode).
 *
 * Bug A: a src do attachment passou a apontar pra '/api/attachments/<id>',
 * um endpoint AUTENTICADO (Bearer JWT). O <audio> nativo não envia headers
 * customizados em request de mídia — então buscamos via fetch+auth, geramos
 * um blob URL com URL.createObjectURL e usamos esse blob como src. O blob
 * fica vinculado ao ciclo de vida do componente (revoke no unmount/troca).
 *
 * Aceita também URLs absolutas (legado, mensagens antigas com URL pública).
 * Nesse caso pula o fetch e usa src direto.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { tokenManager } from '@/api/client';

interface AudioPlayerProps {
  src: string;
  mimeType?: string | null;
  className?: string;
}

const PLAYBACK_RATES = [1, 1.5, 2] as const;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Detecta se o src é o proxy autenticado do backend
 * (caminho relativo iniciando em /api/attachments/...).
 */
function isProxyUrl(src: string): boolean {
  return /^\/?api\/attachments\//.test(src);
}

export function AudioPlayer({ src, mimeType, className }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [isSeeking, setIsSeeking] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState<boolean>(false);

  // Sync rate -> audio element
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  // Resolve src: se for proxy autenticado, baixa com Bearer e gera blob URL.
  // Caso contrário, usa direto.
  useEffect(() => {
    let cancelled = false;
    setHasError(false);
    setResolvedSrc(null);

    const cleanupBlob = () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };

    if (!src) {
      setHasError(true);
      return cleanupBlob;
    }

    if (!isProxyUrl(src)) {
      // URL pública direta (data: ou https://...) — toca direto.
      setResolvedSrc(src);
      return cleanupBlob;
    }

    setIsResolving(true);
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
        cleanupBlob();
        const objectUrl = URL.createObjectURL(blob);
        blobUrlRef.current = objectUrl;
        setResolvedSrc(objectUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setHasError(true);
      })
      .finally(() => {
        if (!cancelled) setIsResolving(false);
      });

    return () => {
      cancelled = true;
      cleanupBlob();
    };
  }, [src]);

  const onLoadedMetadata = useCallback(() => {
    const el = audioRef.current;
    if (el && Number.isFinite(el.duration)) {
      setDuration(el.duration);
    }
  }, []);

  const onTimeUpdate = useCallback(() => {
    const el = audioRef.current;
    if (el && !isSeeking) {
      setCurrentTime(el.currentTime);
    }
  }, [isSeeking]);

  const onEnded = useCallback(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    const el = audioRef.current;
    if (el) el.currentTime = 0;
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(() => setIsPlaying(true)).catch(() => setHasError(true));
      } else {
        setIsPlaying(true);
      }
    } else {
      el.pause();
      setIsPlaying(false);
    }
  }, []);

  const handleSeek = useCallback((values: number[]) => {
    const next = values[0];
    if (typeof next !== 'number') return;
    setCurrentTime(next);
    const el = audioRef.current;
    if (el) el.currentTime = next;
  }, []);

  const cycleRate = useCallback(() => {
    setRate((prev) => {
      const idx = PLAYBACK_RATES.indexOf(prev as (typeof PLAYBACK_RATES)[number]);
      const next = PLAYBACK_RATES[(idx + 1) % PLAYBACK_RATES.length];
      return next;
    });
  }, []);

  // Fallback caso o browser barre completamente o áudio ou o download falhe
  if (hasError) {
    return (
      <div className={cn('flex items-center gap-2 max-w-[260px] rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive', className)}>
        <Volume2 className="w-4 h-4 shrink-0" />
        <span>Não foi possível carregar o áudio.</span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex items-center gap-2 w-[260px] max-w-full rounded-md border border-border bg-muted/40 px-2 py-2',
        className,
      )}
    >
      {/* elemento de áudio invisível */}
      {resolvedSrc ? (
        <audio
          ref={audioRef}
          src={resolvedSrc}
          preload="metadata"
          onLoadedMetadata={onLoadedMetadata}
          onTimeUpdate={onTimeUpdate}
          onEnded={onEnded}
          onError={() => setHasError(true)}
          data-testid="audio-element"
        />
      ) : null}

      <Button
        type="button"
        onClick={togglePlay}
        size="icon"
        variant="default"
        disabled={!resolvedSrc || isResolving}
        aria-label={isPlaying ? 'Pausar áudio' : 'Reproduzir áudio'}
        className="h-8 w-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {isResolving ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : isPlaying ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 ml-0.5" />
        )}
      </Button>

      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <Slider
          value={[currentTime]}
          min={0}
          max={duration || 0.01}
          step={0.1}
          onPointerDown={() => setIsSeeking(true)}
          onPointerUp={() => setIsSeeking(false)}
          onValueChange={handleSeek}
          aria-label="Posição do áudio"
          className="cursor-pointer [&_[role=slider]]:h-3 [&_[role=slider]]:w-3 [&>*:first-child]:h-1"
        />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground font-mono tabular-nums">
          <span>{formatTime(currentTime)}</span>
          <span className="flex items-center gap-1">
            <Volume2 className="w-2.5 h-2.5" />
            {formatTime(duration)}
          </span>
        </div>
      </div>

      <button
        type="button"
        onClick={cycleRate}
        aria-label={`Velocidade ${rate}x — clique para mudar`}
        className="shrink-0 text-[10px] font-semibold text-muted-foreground hover:text-foreground bg-background border border-border rounded px-1.5 py-0.5 min-w-[2.25rem] text-center transition-colors"
      >
        {rate}x
      </button>
    </div>
  );
}

export default AudioPlayer;
