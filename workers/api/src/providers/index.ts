import type { NemotronProvider } from '@credential-reaper/shared';
import { createNemotronProvider } from './nemotron.js';
import { mockNemotronProvider } from './mock.js';

export interface AiProviderEnv {
  NVIDIA_API_KEY?: string;
  NEMOTRON_MODEL?: string;
}

const DEFAULT_MODEL = 'nvidia/llama-3.1-nemotron-70b-instruct';

/** Picks the real Nemotron provider when a key is configured, otherwise the mock. */
export function getAiProvider(env: AiProviderEnv): NemotronProvider {
  if (env.NVIDIA_API_KEY) {
    return createNemotronProvider(env.NVIDIA_API_KEY, env.NEMOTRON_MODEL ?? DEFAULT_MODEL);
  }
  return mockNemotronProvider;
}
