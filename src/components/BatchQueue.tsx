import {
  AlertTriangle,
  Download,
  FileDown,
  MonitorDown
} from 'lucide-react';
import { STRINGS } from '../strings';
import type { Job, BatchJob } from '../types';
import { formatBytes } from '../utils';

export function BatchQueue({
  jobs,
  onSelectJob,
  onRevealJob,
  onSaveAs,
  onCancelJob,
  onCancelAll
}: {
  jobs: BatchJob[];
  onSelectJob: (job: Job) => void;
  onRevealJob: (id: string) => void;
  onSaveAs: (job: Job) => void;
  onCancelJob: (id: string) => void;
  onCancelAll: () => void;
}) {
  if (!jobs.length) return null;

  const completedIds = jobs
    .filter((item) => item.job?.status === 'complete' && item.job.downloadUrl)
    .map((item) => item.job!.id);

  const cancellableCount = jobs.filter((item) => item.job?.status === 'queued' || item.job?.status === 'running').length;

  return (
    <section className="batch-panel" aria-label={STRINGS.batch.aria}>
      <div className="output-title">
        <h3>{STRINGS.batch.title}</h3>
        {cancellableCount > 1 ? (
          <button type="button" className="secondary-button" onClick={onCancelAll}>
            <AlertTriangle aria-hidden="true" />
            {STRINGS.batch.cancelAll}
          </button>
        ) : null}
        {completedIds.length > 1 ? (
          <a className="secondary-button" href={`/api/jobs/zip?ids=${completedIds.join(',')}`} download>
            <Download aria-hidden="true" />
            {STRINGS.batch.downloadAll(completedIds.length)}
          </a>
        ) : null}
      </div>
      <div className="batch-list">
        {jobs.map((item) => {
          const itemJob = item.job;
          const canCancelItem = itemJob?.status === 'queued' || itemJob?.status === 'running';
          return (
            <div key={item.localId} className="batch-row">
              <button type="button" className="batch-main" disabled={!itemJob} onClick={() => itemJob && onSelectJob(itemJob)}>
                <strong>{item.inputName}</strong>
                <span>{batchStatus(item)}</span>
              </button>
              <span>{STRINGS.batch.attempts(itemJob?.attempts.length ?? 0)}</span>
              <span>{itemJob?.outputBytes ? `${formatBytes(itemJob.outputBytes)} / ${formatBytes(itemJob.targetBytes)}` : formatBytes(item.inputSize)}</span>
              <div>
                {itemJob?.status === 'complete' && itemJob.downloadUrl ? (
                  <>
                    <a className="secondary-button" href={itemJob.downloadUrl} download>
                      <Download aria-hidden="true" />
                      {STRINGS.output.download}
                    </a>
                    <button type="button" className="secondary-button" onClick={() => onRevealJob(itemJob.id)}>
                      <MonitorDown aria-hidden="true" />
                      {STRINGS.output.open}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => onSaveAs(itemJob)}>
                      <FileDown aria-hidden="true" />
                      {STRINGS.output.saveAs}
                    </button>
                  </>
                ) : canCancelItem ? (
                  <button type="button" className="secondary-button" onClick={() => onCancelJob(itemJob.id)}>
                    <AlertTriangle aria-hidden="true" />
                    {STRINGS.input.cancel}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function batchStatus(item: BatchJob) {
  if (item.error) return item.error;
  if (!item.job) return item.status === 'failed' ? STRINGS.batch.failedSubmit : STRINGS.batch.pending;
  if (item.job.status === 'queued') return STRINGS.batch.queued(item.job.queuePosition ?? 1);
  if (item.job.status === 'running') return item.job.stage;
  if (item.job.status === 'complete') return STRINGS.batch.complete;
  if (item.job.status === 'cancelled') return STRINGS.batch.cancelled;
  return item.job.error ?? STRINGS.batch.failed;
}
