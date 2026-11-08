import { createNemotronProvider } from './nemotron.js';
import { mockNemotronProvider } from './mock.js';
import type { NemotronProvider } from './types.js';

export interface AiProviderEnv {
  NVIDIA_API_KEY?: string;
  NEMOTRON_MODEL?: string;
}

// Current NVIDIA-hosted Nemotron model with tool calling, served by
// https://integrate.api.nvidia.com/v1 (see GET /v1/models there).
// nemotron-3-super-120b-a12b is catalog-listed but returns 404 for some
// accounts; this model is confirmed working with tool calling.
export const DEFAULT_NEMOTRON_MODEL = 'nvidia/nemotron-3.5-super-vl-120b-a12b';

/** Picks the real Nemotron agent when a key is configured, otherwise the scripted mock. */
export function getAiProvider(env: AiProviderEnv): NemotronProvider {
  const apiKey = env.NVIDIA_API_KEY?.trim();
  if (apiKey) {
    return createNemotronProvider(apiKey, env.NEMOTRON_MODEL?.trim() || DEFAULT_NEMOTRON_MODEL);
  }
  return mockNemotronProvider;
}
