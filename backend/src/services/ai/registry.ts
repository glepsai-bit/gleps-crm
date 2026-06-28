/**
 * T-023 Fase 2 — registry de providers de IA do warmup.
 *
 * Mantem um map estatico de providers conhecidos. Cada provider eh um singleton
 * que decide internamente se esta habilitado (env var presente).
 *
 * Uso:
 *   const provider = getProvider('openai');
 *   if (provider?.isEnabled()) { ... }
 */

import { openaiProvider } from './openai-provider';
import { anthropicProvider } from './anthropic-provider';
import type { AiProvider, AiProviderName } from './types';

const PROVIDERS: Record<AiProviderName, AiProvider> = {
  openai: openaiProvider,
  anthropic: anthropicProvider,
};

export function getProvider(name: AiProviderName | string | null | undefined): AiProvider | null {
  if (!name) return null;
  const found = (PROVIDERS as Record<string, AiProvider>)[name];
  return found ?? null;
}

export function listEnabledProviders(): {
  name: AiProviderName;
  defaultModel: string;
  enabled: boolean;
}[] {
  return (Object.values(PROVIDERS) as AiProvider[]).map(p => ({
    name: p.name,
    defaultModel: p.defaultModel,
    enabled: p.isEnabled(),
  }));
}

export function isAnyProviderEnabled(): boolean {
  return Object.values(PROVIDERS).some(p => p.isEnabled());
}
