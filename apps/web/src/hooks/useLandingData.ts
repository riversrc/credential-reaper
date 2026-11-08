import { useCallback, useEffect, useState } from 'react';
import type { AuditEvent, Investigation, MachineIdentity, RemediationPlan } from '@credential-reaper/shared';
import { fetchAuditEvents, fetchIdentities, fetchIdentityDetail, fetchInvestigations, fetchRemediationPlans } from '../api/client';
import type { IdentityDetail } from '../lib/networkGraph';

export interface LandingData {
  status: 'loading' | 'error' | 'ready';
  error: string | null;
  identities: MachineIdentity[];
  /** A missing entry means that identity's detail request failed; the map still draws the node. */
  details: Record<string, IdentityDetail | undefined>;
  failedDetails: number;
  investigations: Investigation[] | null;
  plans: RemediationPlan[] | null;
  audit: AuditEvent[] | null;
}

const INITIAL: LandingData = {
  status: 'loading',
  error: null,
  identities: [],
  details: {},
  failedDetails: 0,
  investigations: null,
  plans: null,
  audit: null,
};

const settled = <T,>(r: PromiseSettledResult<T>) => (r.status === 'fulfilled' ? r.value : null);

export function useLandingData() {
  const [data, setData] = useState<LandingData>(INITIAL);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const identities = await fetchIdentities();
        const [detailResults, investigations, plans, audit] = await Promise.all([
          Promise.allSettled(identities.map((i) => fetchIdentityDetail(i.id))),
          Promise.allSettled([fetchInvestigations()]).then(([r]) => settled(r)),
          Promise.allSettled([fetchRemediationPlans()]).then(([r]) => settled(r)),
          Promise.allSettled([fetchAuditEvents()]).then(([r]) => settled(r)),
        ]);
        if (cancelled) return;
        const details: Record<string, IdentityDetail | undefined> = {};
        let failedDetails = 0;
        detailResults.forEach((r, idx) => {
          if (r.status === 'fulfilled') details[identities[idx].id] = r.value;
          else failedDetails++;
        });
        setData({ status: 'ready', error: null, identities, details, failedDetails, investigations, plans, audit });
      } catch (e) {
        if (!cancelled) setData({ ...INITIAL, status: 'error', error: String((e as Error).message ?? e) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setData(INITIAL);
    setAttempt((a) => a + 1);
  }, []);

  return { data, reload };
}
