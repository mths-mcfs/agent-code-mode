/** Wait before the next attempt, after `failedAttempts` failed attempts. */
export function backoffDelay(policy, failedAttempts) {
  return Math.min(policy.maxMs, policy.baseMs * policy.factor ** (failedAttempts - 1));
}

/**
 * Called when an attempt of `job` failed: gives up when the attempts are spent, otherwise parks the
 * job for its backoff and puts it back in line afterwards.
 */
export function handleFailure(job, err, { policy, clock, counters, requeue }) {
  if (job.attempt >= policy.maxAttempts) {
    job.reject(err);
    return;
  }
  // The slot is given back by the runner as soon as this returns, so the backoff does not hold it.
  counters.delayed += 1;
  clock.setTimeout(() => {
    counters.delayed -= 1;
    requeue(job);
  }, backoffDelay(policy, job.attempt));
}
