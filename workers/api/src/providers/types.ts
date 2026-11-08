import type { Toolbox } from '../agent/tools.js';

export interface InvestigationRun {
  investigationId: string;
  identityId: string;
  identityName: string;
  toolbox: Toolbox;
}

export interface AgentOutcome {
  /** The agent's closing plain-text summary. */
  summary: string;
  /** Set when a limit (turns, tool calls, time) ended the run before the agent finished on its own. */
  stoppedEarly?: string;
}

/**
 * Implemented once for the real NVIDIA Nemotron API and once as a scripted mock.
 * Both gather evidence only through `run.toolbox`, so tool calls hit real
 * SpacetimeDB data in either mode.
 */
export interface NemotronProvider {
  readonly name: 'nemotron' | 'mock';
  readonly model: string;
  investigate(run: InvestigationRun): Promise<AgentOutcome>;
}
