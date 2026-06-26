import { Terminal } from 'lucide-react';
import { STRINGS } from '../strings';
import type { Job } from '../types';
import { EmptyState } from './EmptyState';

export function LogPanel({ job }: { job: Job | null }) {
  const hasLogs = Boolean(job?.logs.length);
  return (
    <section className="log-panel" aria-label={STRINGS.log.aria}>
      <div className="output-title">
        <Terminal aria-hidden="true" />
        <h3>{STRINGS.log.title}</h3>
      </div>
      {hasLogs ? (
        <pre className="log-scroll">{job?.logs.slice(-200).join('\n')}</pre>
      ) : (
        <div className="log-empty">
          <EmptyState icon={<Terminal aria-hidden="true" />} title={STRINGS.log.emptyTitle} body={STRINGS.log.empty} compact />
        </div>
      )}
    </section>
  );
}
