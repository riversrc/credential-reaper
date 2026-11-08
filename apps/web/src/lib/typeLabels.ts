import type { IdentityType } from '@credential-reaper/shared';

export const TYPE_LABEL: Record<IdentityType, string> = {
  'service-account': 'service account',
  'api-key': 'API key',
  'oauth-app': 'OAuth app',
  'ssh-key': 'SSH key',
  certificate: 'certificate',
  'bot-account': 'bot account',
  webhook: 'webhook',
};
