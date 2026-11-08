import type { RepositoryScanCounts } from '@credential-reaper/shared';

// Baseline inventory documented in the Arasaka repo's docs/BASELINE_CATALOG.md.
// Service-to-service edges include the 11 api-gateway health-probe edges.
export const ARASAKA_EXPECTED: Partial<RepositoryScanCounts> = {
  services: 12,
  endpoints: 107,
  machineIdentities: 44,
  permissions: 63,
  assignments: 93,
  teams: 10,
  people: 20,
  serviceDependencies: 38,
  providerDependencies: 5,
};
