export class Attribution {
  constructor() {
    this.units = new Map()
  }

  record(result, userId) {
    const outcome = result?.outcome || {}
    for (const id of [
      ...(outcome.touched || []),
      ...(outcome.added || []),
      ...(outcome.removed || []),
    ]) {
      this.units.set(id, {
        user_id: userId || null,
        edit_id: result.edit_id,
        source_revision: result.source_revision,
      })
    }
  }

  forEvent(event) {
    const entry = this.units.get(event.par_id)
    // An old result must never be attributed to a later collaborator's edit.
    if (entry && event.edit_id < entry.edit_id) {
      return { stale: true }
    }
    return { user_id: entry?.user_id || null }
  }
}
