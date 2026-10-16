// rtex 0.0.3 reports the source revision at delivery, which can be newer than
// the pass snapshot. Stale.pending_since is the first revision outside it.
export function snapshotRevision(header) {
  return (
    header.snapshot_source_revision ??
    (header.convergence?.state === 'Stale'
      ? header.convergence.pending_since - 1
      : header.versions?.source_revision) ??
    0
  )
}

export function newerThanLayout(paragraph, layout) {
  return (paragraph.versions?.source_revision ?? 0) > snapshotRevision(layout)
}
