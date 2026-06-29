import { cn } from '@/lib/utils';
import glepsLogo from '@/assets/gleps-logo.png';

interface LogoProps {
  variant?: 'full' | 'icon';
  className?: string;
}

/**
 * Logo Gleps — usa o asset PNG oficial em src/assets/gleps-logo.png.
 * variant="full"  → logo + wordmark "Gleps"
 * variant="icon"  → apenas o icone (sidebar recolhida, mobile header)
 */
export function Logo({ variant = 'full', className }: LogoProps) {
  if (variant === 'icon') {
    return (
      <img
        src={glepsLogo}
        alt="Gleps"
        className={cn('h-8 w-8 object-contain', className)}
      />
    );
  }

  // variant === 'full' — logo + wordmark
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <img
        src={glepsLogo}
        alt="Gleps"
        className="h-10 w-10 object-contain shrink-0"
      />
      <span className="text-2xl font-extrabold tracking-tight text-current">
        Gleps
      </span>
    </div>
  );
}

export default Logo;
