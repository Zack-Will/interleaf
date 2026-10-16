import { describe, it, expect } from 'vitest'
import { snapshotRevision, newerThanLayout } from '../../Layout.mjs'

describe('layout snapshot revisions', () => {
  it('distinguishes a stale snapshot from the source revision at delivery', () => {
    const layout = {
      versions: { source_revision: 10 },
      convergence: { state: 'Stale', pending_since: 6 },
    }
    expect(snapshotRevision(layout)).toBe(5)
    expect(newerThanLayout({ versions: { source_revision: 6 } }, layout)).toBe(
      true
    )
    expect(newerThanLayout({ versions: { source_revision: 5 } }, layout)).toBe(
      false
    )
    expect(snapshotRevision({ ...layout, snapshot_source_revision: 4 })).toBe(4)
    expect(snapshotRevision({ versions: { source_revision: 8 } })).toBe(8)
  })
})
