import type { BackfillSchedule } from '../../../application/backfill/result/types';
import { parseDuration } from '../../../../common';

export type ScheduledItem = {
  from: Date,
  to: Date,
  status: BackfillSchedule['status']
}

export const toScheduledItem = (backfillSchedule: BackfillSchedule): ScheduledItem => {
  const runAt = new Date(backfillSchedule.runAt).getTime();
  const intervalDuration = parseDuration(backfillSchedule.interval);
  const from = runAt - intervalDuration;
  const to = runAt;
  return {
    from: new Date(from),
    to: new Date(to),
    status: backfillSchedule.status
  };
}