/**
 * O catálogo de modelos é a fonte única das duas telas de agente. Estes testes
 * travam o que o admin vê (quais modelos, com que preço) e a regra que decide
 * quando o seletor de raciocínio aparece e o que vai para o backend.
 */
import { describe, it, expect } from 'vitest';
import {
  MODELOS_IA,
  NIVEIS_DE_RACIOCINIO,
  PADRAO_DO_PROVEDOR,
  RACIOCINIO_PADRAO,
  ehModeloDeRaciocinio,
  modeloDoCatalogo,
  raciocinioParaSalvar,
  rotuloDoModelo,
  textoDoPreco,
} from './modelosIa';

describe('catálogo', () => {
  it('a OpenAI oferece os oito modelos, com gpt-4.1 à frente (o recomendado para venda)', () => {
    expect(MODELOS_IA.openai.map((m) => m.id)).toEqual([
      'gpt-4.1',
      'gpt-5-mini',
      'gpt-5',
      'gpt-4.1-mini',
      'gpt-5-nano',
      'gpt-4o-mini',
      'gpt-4o',
      'o4-mini',
    ]);
  });

  it('a Anthropic oferece haiku, sonnet e opus', () => {
    expect(MODELOS_IA.anthropic.map((m) => m.id)).toEqual([
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-opus-5',
    ]);
  });

  it('o preço de cada modelo é o combinado (US$ por 1M tokens, entrada / saída)', () => {
    const precos = Object.fromEntries(
      [...MODELOS_IA.openai, ...MODELOS_IA.anthropic].map((m) => [m.id, [m.entrada, m.saida]])
    );
    expect(precos).toEqual({
      'gpt-4.1': [2, 8],
      'gpt-5-mini': [0.25, 2],
      'gpt-5': [1.25, 10],
      'gpt-4.1-mini': [0.4, 1.6],
      'gpt-5-nano': [0.05, 0.4],
      'gpt-4o-mini': [0.15, 0.6],
      'gpt-4o': [2.5, 10],
      'o4-mini': [1.1, 4.4],
      'claude-haiku-4-5': [1, 5],
      'claude-sonnet-5': [3, 15],
      'claude-opus-5': [5, 25],
    });
  });

  it('o rótulo é "id — uso", e só o id quando não há uso a dizer', () => {
    expect(rotuloDoModelo(modeloDoCatalogo('openai', 'gpt-4.1')!)).toBe('gpt-4.1 — recomendado para venda');
    expect(rotuloDoModelo(modeloDoCatalogo('openai', 'gpt-5-mini')!)).toBe(
      'gpt-5-mini — custo-benefício, raciocínio'
    );
    expect(rotuloDoModelo(modeloDoCatalogo('openai', 'gpt-4o')!)).toBe('gpt-4o');
    expect(rotuloDoModelo(modeloDoCatalogo('anthropic', 'claude-sonnet-5')!)).toBe(
      'claude-sonnet-5 — equilíbrio'
    );
  });

  it('o catálogo e a regra de raciocínio concordam: marcado ⇔ ehModeloDeRaciocinio', () => {
    for (const modelo of [...MODELOS_IA.openai, ...MODELOS_IA.anthropic]) {
      expect(ehModeloDeRaciocinio(modelo.id), modelo.id).toBe(modelo.raciocinio === true);
    }
  });

  it('não repete id dentro de um provedor', () => {
    for (const lista of Object.values(MODELOS_IA)) {
      const ids = lista.map((m) => m.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('o padrão do provedor é o que o backend roda quando o agente não escolhe', () => {
    // Espelha DEFAULT_MODEL de backend/src/services/ai/chat.ts.
    expect(PADRAO_DO_PROVEDOR).toEqual({
      openai: 'gpt-4o-mini',
      anthropic: 'claude-haiku-4-5-20251001',
    });
  });
});

describe('modeloDoCatalogo', () => {
  it('acha pelo id exato, e só no provedor certo', () => {
    expect(modeloDoCatalogo('openai', 'gpt-5')?.id).toBe('gpt-5');
    expect(modeloDoCatalogo('openai', ' gpt-5 ')?.id).toBe('gpt-5');
    expect(modeloDoCatalogo('anthropic', 'gpt-5')).toBeNull();
  });

  it('gpt-5.1 não é o gpt-5: tem outro preço, então é "outro modelo"', () => {
    expect(modeloDoCatalogo('openai', 'gpt-5.1')).toBeNull();
    expect(modeloDoCatalogo('openai', 'gpt-5-pro')).toBeNull();
  });
});

describe('ehModeloDeRaciocinio', () => {
  it.each(['gpt-5', 'gpt-5-mini', 'gpt-5.1-mini', 'gpt-5.1', 'o4-mini', 'o1', 'o3'])(
    '%s raciocina',
    (id) => {
      expect(ehModeloDeRaciocinio(id)).toBe(true);
    }
  );

  it.each(['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4o-mini', 'claude-opus-5', 'omni-moderation-latest'])(
    '%s não raciocina',
    (id) => {
      expect(ehModeloDeRaciocinio(id)).toBe(false);
    }
  );

  it('vazio (padrão do provedor) e ausente não raciocinam', () => {
    expect(ehModeloDeRaciocinio('')).toBe(false);
    expect(ehModeloDeRaciocinio(null)).toBe(false);
    expect(ehModeloDeRaciocinio(undefined)).toBe(false);
  });

  it('ignora espaço e caixa, como o backend', () => {
    expect(ehModeloDeRaciocinio(' GPT-5.1 ')).toBe(true);
  });
});

describe('textoDoPreco', () => {
  it('escreve o preço em pt-BR, entrada e saída por 1M tokens', () => {
    expect(textoDoPreco('openai', 'gpt-4.1')).toBe('US$ 2,00 entrada / 8,00 saída por 1M tokens');
    expect(textoDoPreco('openai', 'gpt-5-nano')).toBe('US$ 0,05 entrada / 0,40 saída por 1M tokens');
    expect(textoDoPreco('anthropic', 'claude-opus-5')).toBe('US$ 5,00 entrada / 25,00 saída por 1M tokens');
  });

  it('sem modelo escolhido, mostra o preço do padrão do provedor, que é o que vai rodar', () => {
    expect(textoDoPreco('openai', '')).toBe('US$ 0,15 entrada / 0,60 saída por 1M tokens');
    // O padrão da Anthropic leva a data da versão no id; o preço é o do haiku-4-5.
    expect(textoDoPreco('anthropic', '')).toBe('US$ 1,00 entrada / 5,00 saída por 1M tokens');
  });

  it('id com carimbo de versão acha o preço do modelo base', () => {
    expect(textoDoPreco('openai', 'gpt-4o-2024-08-06')).toBe('US$ 2,50 entrada / 10,00 saída por 1M tokens');
  });

  it('some (null) quando o modelo não está no catálogo', () => {
    expect(textoDoPreco('openai', 'gpt-5.1')).toBeNull();
    expect(textoDoPreco('anthropic', 'claude-qualquer-coisa')).toBeNull();
  });
});

describe('raciocínio', () => {
  it('Mínimo, Baixo, Médio e Alto, nessa ordem, com o valor que o backend entende', () => {
    expect(NIVEIS_DE_RACIOCINIO).toEqual([
      { valor: 'minimal', rotulo: 'Mínimo' },
      { valor: 'low', rotulo: 'Baixo' },
      { valor: 'medium', rotulo: 'Médio' },
      { valor: 'high', rotulo: 'Alto' },
    ]);
    expect(RACIOCINIO_PADRAO).toBe('low');
  });

  it('modelo de raciocínio sem nível escolhido salva o padrão (Baixo)', () => {
    expect(raciocinioParaSalvar('gpt-5-mini', null)).toBe('low');
    expect(raciocinioParaSalvar('gpt-5.1', undefined)).toBe('low');
  });

  it('modelo de raciocínio com nível escolhido salva o nível', () => {
    expect(raciocinioParaSalvar('gpt-5', 'high')).toBe('high');
    expect(raciocinioParaSalvar('o4-mini', 'minimal')).toBe('minimal');
  });

  it('modelo que não raciocina salva null — mesmo com um nível guardado na tela', () => {
    expect(raciocinioParaSalvar('gpt-4.1', 'high')).toBeNull();
    expect(raciocinioParaSalvar('', 'high')).toBeNull();
    expect(raciocinioParaSalvar(null, 'medium')).toBeNull();
  });
});
