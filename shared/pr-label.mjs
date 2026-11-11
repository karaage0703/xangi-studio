/** The source is the owner/repository saved by the GitHub importer. */
export function pullRequestLabel(changeSet) {
  return changeSet?.kind === "github-pr"
    ? `${changeSet.source} #${changeSet.id}`
    : changeSet?.kind === "github-repository"
      ? `${changeSet.source} (${changeSet.id})`
      : null;
}

/** Separate incomplete repository snapshots in the UI while keeping one archive key per branch. */
export function githubGroupKey(changeSet) {
  if (!changeSet) return "standalone";
  const key = `${changeSet.kind}:${changeSet.source}:${changeSet.id}`;
  return changeSet.kind === "github-repository"
    ? `${key}@${changeSet.revision}`
    : key;
}
