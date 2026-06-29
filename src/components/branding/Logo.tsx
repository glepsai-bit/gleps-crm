import { cn } from '@/lib/utils';

interface LogoProps {
  variant?: 'full' | 'icon';
  className?: string;
}

/**
 * Logo Gleps — inline SVG, sem dependência de arquivo externo.
 * variant="full"  → ícone "g" geométrico + wordmark "Gleps"
 * variant="icon"  → apenas o ícone "g" (sidebar recolhida, favicon 32px)
 *
 * Usa currentColor para herdar a cor do contexto (branco na sidebar escura,
 * roxo primário onde preferir). Para usar a cor roxa da marca, aplique
 * a classe `text-primary` ou `text-[#5B3DF5]` via className.
 */
export function Logo({ variant = 'full', className }: LogoProps) {
  if (variant === 'icon') {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        fill="none"
        aria-label="Gleps"
        role="img"
        className={cn('h-8 w-8', className)}
      >
        {/* Quadrado arredondado roxo (preenchimento) */}
        <rect x="1" y="1" width="30" height="30" rx="7" fill="currentColor" />
        {/* Letra "g" estilizada em contraste — usa white para herdar fundo */}
        <text
          x="16"
          y="23"
          fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
          fontWeight="800"
          fontSize="20"
          fill="white"
          textAnchor="middle"
          letterSpacing="-0.5"
        >
          g
        </text>
      </svg>
    );
  }

  // variant === 'full'
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 180 48"
      fill="none"
      aria-label="Gleps"
      role="img"
      className={cn('h-10 w-auto', className)}
    >
      {/* Mark — quadrado arredondado com "g" */}
      <g transform="translate(0, 6)">
        <rect x="0" y="0" width="36" height="36" rx="8" fill="currentColor" />
        <text
          x="18"
          y="26"
          fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
          fontWeight="800"
          fontSize="24"
          fill="white"
          textAnchor="middle"
          letterSpacing="-0.5"
        >
          g
        </text>
      </g>
      {/* Wordmark "Gleps" */}
      <text
        x="48"
        y="34"
        fontFamily="'Inter', 'Helvetica Neue', Arial, sans-serif"
        fontWeight="800"
        fontSize="26"
        fill="currentColor"
        letterSpacing="-0.5"
      >
        Gleps
      </text>
    </svg>
  );
}

export default Logo;
