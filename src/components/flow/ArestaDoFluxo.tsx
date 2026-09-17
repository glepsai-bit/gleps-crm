/**
 * A ligação entre dois passos.
 *
 * Existe por três motivos que a aresta padrão do React Flow não cobre:
 *
 * 1. **Dá pra apagar.** Com `deleteKeyCode={null}` (o Select do shadcn é um
 *    <button role="combobox"> e o Backspace nele apagaria o bloco inteiro) a
 *    tecla Delete não existe neste canvas. Sem um botão na própria aresta, uma
 *    ligação desenhada errado só sumia apagando um dos blocos que ela liga.
 *    Mesmo caminho que o n8n escolheu: tecla desligada, lixeira no hover.
 * 2. **Dá pra acertar.** A faixa invisível de clique sobe de 20px (padrão) para
 *    40px, e o botão só some 500ms depois que o ponteiro sai — tempo de levar o
 *    mouse até ele sem ele fugir.
 * 3. **O rótulo do ramo é legível nos dois temas.** O rótulo padrão é SVG com
 *    fundo branco e texto escuro, que some no modo escuro.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { useEditorDeFluxo } from './EditorDeFluxoContext';

/** Quanto tempo o botão sobrevive depois que o ponteiro sai. */
const MS_HISTERESE = 500;

export function ArestaDoFluxo({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
  data,
}: EdgeProps) {
  const editor = useEditorDeFluxo();
  const [sobre, setSobre] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const entrar = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    setSobre(true);
  }, []);
  const sair = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setSobre(false), MS_HISTERESE);
  }, []);

  const [caminho, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 12,
    offset: 24,
  });

  // `sem_atendente` vira "sem atendente", igual ao rótulo da porta no bloco.
  const ramo = typeof data?.branch === 'string' ? data.branch.replace(/_/g, ' ') : null;
  const mostrar = sobre || Boolean(selected);

  return (
    <>
      {/* O <g> é quem escuta o ponteiro: o alvo real é a faixa invisível de 40px
          que o BaseEdge desenha em volta do traço, não o traço de 2px. */}
      <g onMouseEnter={entrar} onMouseLeave={sair}>
        <BaseEdge
          id={id}
          path={caminho}
          markerEnd={markerEnd}
          interactionWidth={40}
          style={{
            ...style,
            stroke: selected || sobre ? 'hsl(var(--primary))' : style?.stroke,
            strokeWidth: selected || sobre ? 2.5 : style?.strokeWidth,
          }}
        />
      </g>

      <EdgeLabelRenderer>
        <div
          className="nodrag nopan absolute flex items-center gap-1"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: 'all',
          }}
          onMouseEnter={entrar}
          onMouseLeave={sair}
        >
          {ramo && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-foreground border shadow-sm">
              {ramo}
            </span>
          )}
          {editor && (
            <button
              type="button"
              aria-label="Remover ligação"
              title="Remover ligação"
              onClick={() => editor.removerAresta(id)}
              className={`grid h-5 w-5 place-items-center rounded-full border bg-card text-muted-foreground shadow-sm transition-opacity hover:border-destructive hover:text-destructive ${
                mostrar ? 'opacity-100' : 'pointer-events-none opacity-0'
              }`}
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
