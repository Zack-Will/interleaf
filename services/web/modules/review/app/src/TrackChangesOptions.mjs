import { Project } from '../../../../app/src/models/Project.mjs'

// Persists the project's track-changes state from the review panel's toggle
// request. CE's ProjectOptionsHandler has no setter for it, so the module
// keeps its own instead of patching that core file.
async function setTrackChanges(projectId, body) {
  let trackChanges
  if (typeof body.on === 'boolean') {
    trackChanges = body.on
  } else if (body.on_for != null) {
    trackChanges = { ...body.on_for }
  } else if (typeof body.on_for_guests === 'boolean') {
    trackChanges = { __guests__: body.on_for_guests }
  } else {
    trackChanges = {}
  }
  if (
    typeof body.on_for_guests === 'boolean' &&
    typeof trackChanges === 'object'
  ) {
    trackChanges.__guests__ = body.on_for_guests
  }
  return Project.updateOne({ _id: projectId }, { track_changes: trackChanges })
}

export default {
  promises: { setTrackChanges },
}
