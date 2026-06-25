/**
 * AudioPlayer — T-022 BUG-5
 *
 * Player de áudio custom estilizado (verde primary) para substituir o
 * <audio controls /> nativo (UX pobre, visual quebrado em dark mode).
 *
 * Features:
 *  - Botão play/pause com ícones lucide
 *  - Barra de progresso (Slider shadcn) com scrub
 *  - Tempo decorrido / total em mm:ss
 *  - Botão de velocidade (1x / 1.5x / 2x) — comum em áudios de WhatsApp
 *  - Fallback para <audio controls /> se MediaElement API indisponível
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';

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

export function AudioPlayer({ src, mimeType, className }: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [isSeeking, setIsSeeking] = useState(false);
  const [hasError, setHasError] = useState(false);

  // Sync rate -> audio element
  useEffect(() => {
    const el = audioRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

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

  // Fallback caso o browser barre completamente o áudio
  if (hasError) {
    return (
      <audio controls preload="metadata" className={cn('max-w-[260px]', className)}>
        <source src={src} type={mimeType || 'audio/mpeg'} />
        Seu navegador não suporta o player de áudio.
      </audio>
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
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onLoadedMetadata={onLoadedMetadata}
        onTimeUpdate={onTimeUpdate}
        onEnded={onEnded}
        onError={() => setHasError(true)}
      >
        {/* fallback para browsers muito antigos */}
        <source src={src} type={mimeType || 'audio/mpeg'} />
      </audio>

      <Button
        type="button"
        onClick={togglePlay}
        size="icon"
        variant="default"
        aria-label={isPlaying ? 'Pausar áudio' : 'Reproduzir áudio'}
        className="h-8 w-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
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
