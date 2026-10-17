/**
 * A escolha de modelo do agente, igual nas duas telas — `PainelAgente` (no
 * canvas) e `AdminIaAgentesPage` — e alimentada pelo catálogo único de
 * `@/config/modelosIa`. Antes cada tela tinha a sua lista escrita à mão.
 *
 * São duas peças porque o nível de raciocínio só existe para alguns modelos, e
 * quem decide onde ele entra no layout (e se entra) é a tela:
 *  - `SeletorDeModelo`: o Select, o campo do id em "Outro modelo…" e o preço.
 *  - `SeletorDeRaciocinio`: Mínimo / Baixo / Médio / Alto.
 */
import { useRef, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { AiProviderName, NivelDeRaciocinio } from '@/services/ai.backend.service';
import {
  MODELOS_IA,
  NIVEIS_DE_RACIOCINIO,
  PADRAO_DO_PROVEDOR,
  RACIOCINIO_PADRAO,
  modeloDoCatalogo,
  rotuloDoModelo,
  textoDoPreco,
} from '@/config/modelosIa';

// Valores internos do Select: o Radix não aceita value vazio, e o "vazio" do
// agente (`model: ''` → o backend usa o padrão do provedor) precisa de um nome.
const PADRAO = '__padrao__';
const OUTRO = '__outro__';

interface SeletorDeModeloProps {
  provider: AiProviderName;
  /** O id gravado no agente; `''` = padrão do provedor. */
  model: string;
  onChange: (model: string) => void;
  /** Prefixo dos ids dos campos (`pa` → `pa-modelo`), que ligam rótulo e campo. */
  idBase: string;
  /** Versão do painel estreito: rótulo e campos menores. */
  compacto?: boolean;
}

/**
 * "Outro modelo…" vale por si só — um id digitado como `gpt-5.1`. O modo é
 * DERIVADO do `model` (id fora do catálogo → "outro", é o que faz a tela abrir
 * certa para um agente que já tem um modelo de fora), mais um fiapo de estado
 * local: quem escolhe "Outro modelo…" ou digita no campo continua no modo, mesmo
 * que o id vire, no meio da digitação, um que o catálogo conhece (`gpt-5` a
 * caminho de `gpt-5.1`) ou fique vazio. O pai troca a `key` quando muda o agente
 * ou o provedor, que é quando esse fiapo precisa recomeçar.
 */
export function SeletorDeModelo({
  provider,
  model,
  onChange,
  idBase,
  compacto = false,
}: SeletorDeModeloProps) {
  const [escolheuOutro, setEscolheuOutro] = useState(false);
  const campoDoId = useRef<HTMLInputElement>(null);
  const focarNoCampo = useRef(false);

  const foraDoCatalogo = model.trim() !== '' && !modeloDoCatalogo(provider, model);
  const modoOutro = escolheuOutro || foraDoCatalogo;
  const preco = textoDoPreco(provider, model);

  const escolher = (valor: string) => {
    if (valor === OUTRO) {
      // O `model` não muda: o campo abre com o id que já estava, pronto para editar.
      focarNoCampo.current = true;
      setEscolheuOutro(true);
      return;
    }
    setEscolheuOutro(false);
    onChange(valor === PADRAO ? '' : valor);
  };

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${idBase}-modelo`} className={compacto ? 'text-xs' : undefined}>
        Modelo
      </Label>
      <Select value={modoOutro ? OUTRO : model.trim() || PADRAO} onValueChange={escolher}>
        <SelectTrigger id={`${idBase}-modelo`} className={compacto ? 'h-9' : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          // Ao fechar, o Radix devolve o foco ao gatilho; em "Outro modelo…" o
          // próximo passo é digitar, então o foco vai para o campo do id.
          onCloseAutoFocus={(e) => {
            if (!focarNoCampo.current) return;
            focarNoCampo.current = false;
            e.preventDefault();
            campoDoId.current?.focus();
          }}
        >
          <SelectItem value={PADRAO}>Padrão do provedor ({PADRAO_DO_PROVEDOR[provider]})</SelectItem>
          {MODELOS_IA[provider].map((m) => (
            <SelectItem key={m.id} value={m.id}>
              {rotuloDoModelo(m)}
            </SelectItem>
          ))}
          <SelectItem value={OUTRO}>Outro modelo…</SelectItem>
        </SelectContent>
      </Select>
      {modoOutro && (
        <Input
          ref={campoDoId}
          aria-label="Id do modelo"
          className={compacto ? 'h-9' : undefined}
          value={model}
          onChange={(e) => {
            setEscolheuOutro(true);
            onChange(e.target.value);
          }}
          placeholder={provider === 'openai' ? 'ex.: gpt-5.1' : 'ex.: claude-opus-4-8'}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
        />
      )}
      {preco && (
        <p className={cn('text-muted-foreground', compacto ? 'text-[11px]' : 'text-xs')}>{preco}</p>
      )}
    </div>
  );
}

interface SeletorDeRaciocinioProps {
  /** O nível gravado no agente; `null` mostra o padrão (Baixo), que é o que será salvo. */
  valor: NivelDeRaciocinio | null | undefined;
  onChange: (nivel: NivelDeRaciocinio) => void;
  id: string;
  compacto?: boolean;
}

export function SeletorDeRaciocinio({ valor, onChange, id, compacto = false }: SeletorDeRaciocinioProps) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className={compacto ? 'text-xs' : undefined}>
        Raciocínio
      </Label>
      <Select
        value={valor ?? RACIOCINIO_PADRAO}
        onValueChange={(v) => onChange(v as NivelDeRaciocinio)}
      >
        <SelectTrigger id={id} className={compacto ? 'h-9' : undefined}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NIVEIS_DE_RACIOCINIO.map((n) => (
            <SelectItem key={n.valor} value={n.valor}>
              {n.rotulo}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className={cn('text-muted-foreground', compacto ? 'text-[11px]' : 'text-xs')}>
        Quanto o modelo pensa antes de responder. Mais alto = resposta mais lenta e mais cara.
      </p>
    </div>
  );
}
