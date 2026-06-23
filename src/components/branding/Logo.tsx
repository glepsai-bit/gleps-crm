import { cn } from '@/lib/utils';

interface LogoProps {
  variant?: 'full' | 'icon';
  className?: string;
}

/**
 * Logo FitPark — inline SVG, sem dependência de arquivo externo.
 * variant="full"  → haltere + wordmark "FitPark"
 * variant="icon"  → apenas o haltere (sidebar recolhida, favicon 32px)
 *
 * Usa currentColor para herdar a cor do contexto (branco na sidebar escura,
 * verde primário onde preferir). Para usar a cor verde da marca, aplique
 * a classe `text-primary` ou `text-[#10B981]` via className.
 */
export function Logo({ variant = 'full', className }: LogoProps) {
  if (variant === 'icon') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        aria-label="FitPark"
        role="img"
        className={cn('h-8 w-8', className)}
      >
        {/* Left weight */}
        <rect x="1" y="9" width="6" height="14" rx="2" fill="currentColor" />
        {/* Left connector */}
        <rect x="7" y="12" width="4" height="8" rx="1" fill="currentColor" opacity="0.8" />
        {/* Center bar */}
        <rect x="11" y="14" width="10" height="4" rx="1" fill="currentColor" />
        {/* Right connector */}
        <rect x="21" y="12" width="4" height="8" rx="1" fill="currentColor" opacity="0.8" />
        {/* Right weight */}
        <rect x="25" y="9" width="6" height="14" rx="2" fill="currentColor" />
      </svg>
    );
  }

  // variant === 'full'
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 48"
      fill="none"
      aria-label="FitPark"
      role="img"
      className={cn('h-10 w-auto', className)}
    >
      {/* Dumbbell icon */}
      <g transform="translate(0, 4)">
        {/* Left weight */}
        <rect x="2" y="10" width="8" height="20" rx="2" fill="currentColor" />
        {/* Left connector */}
        <rect x="10" y="16" width="6" height="8" rx="1" fill="currentColor" opacity="0.7" />
        {/* Center bar */}
        <rect x="16" y="18" width="20" height="4" rx="1" fill="currentColor" />
        {/* Right connector */}
        <rect x="36" y="16" width="6" height="8" rx="1" fill="currentColor" opacity="0.7" />
        {/* Right weight */}
        <rect x="42" y="10" width="8" height="20" rx="2" fill="currentColor" />
      </g>
      {/* FitPark wordmark */}
      <text
        x="60"
        y="34"
        fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="26"
        fill="currentColor"
        letterSpacing="-0.5"
      >
        FitPark
      </text>
    </svg>
  );
}

export default Logo;
