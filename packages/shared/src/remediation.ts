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
  /** Pull request opened for this plan ('' until then). It changes repository configuration only. */
  prUrl?: string;
  prBranch?: string;
  prOpenedAt?: string;
}

/** What opening a pull request for a plan would change in the repository. */
export interface RemediationPrPreview {
  planId: string;
  repo: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  title: string;
  files: Array<{ path: string; change: 'deleted' | 'modified'; removedLines: string[] }>;
  /** Checks run on the proposed change by re-scanning it in memory. */
  verification: Array<{ check: string; ok: boolean }>;
  /** Files that still mention the identity and are not changed (for example documentation). */
  leftUntouched: string[];
}
