// Each group has its own conversation, including when one project is selected.
// Bound fan-out to three groups per reviewer; never drop or duplicate a file.
export function partitionReviewFiles(files) {
  const groups = Array.from({ length: Math.min(3, files.length) }, () => []);
  const weights = groups.map(() => 0);
  const size = (file) => Math.max(1, file.content?.length ?? 1);
  for (const file of [...files].sort(
    (a, b) => size(b) - size(a) || a.file.localeCompare(b.file),
  )) {
    const index = weights.indexOf(Math.min(...weights));
    groups[index].push(file);
    weights[index] += size(file);
  }
  return groups.map((group) =>
    group.sort((a, b) => a.file.localeCompare(b.file)),
  );
}

export const reviewJobKey = (job) =>
  JSON.stringify([
    job.purpose ?? "legacy",
    job.reviewer?.id ?? "xangi-default",
    job.file ?? null,
    job.files ?? null,
  ]);

// Register every conversation durably before sending its prompt. Do not await
// generation: ReviewJobs collects results even after the browser disconnects.
export function launchReviewWork(
  work,
  { createSession, register, send, onJob, onSendError },
) {
  return Promise.allSettled(
    work.map(async (item) => {
      const sessionId = await createSession(item);
      const job = await register(sessionId, item);
      onJob(job);
      if (job.sessionId === sessionId)
        void Promise.resolve()
          .then(() => send(sessionId, item))
          .catch((error) => onSendError(error, item));
      return job;
    }),
  );
}
