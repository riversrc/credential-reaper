export type RemediationAction = 'retire' | 'rotate' | 'migrate' | 'monitor';

export type RemediationStatus = 'proposed' | 'approved' | 'simulated' | 'rejected';

export interface RemediationStep {
  id: string;
  order: number;
  description: string;
  automatable: boolean;
}

export interface RemediationPlan {
  id: string;
  identityId: string;
  identityName: string;
  investigationId: string | null;
  action: RemediationAction;
  justification: string;
  steps: RemediationStep[];
  status: RemediationStatus;
  createdAt: string;
  /** Set when a simulated (non-destructive) dry run has been recorded. */
  simulatedAt: string | null;
  /** When a human approved or rejected the plan (absent on plans that predate approval). */
  decidedAt?: string | null;
  decidedBy?: string | null;
}
