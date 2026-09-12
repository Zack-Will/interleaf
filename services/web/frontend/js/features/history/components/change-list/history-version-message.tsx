import { LoadedUpdate } from '../../services/types/update'

// An agent write no longer leaves a label behind, so the message the agent sent
// with it — why the change was made — lives in the persisted origin. This is
// where a human reads it: one muted line under the author line, truncated to
// the width of the panel, with the whole message in the tooltip.
function HistoryVersionMessage({
  origin,
}: Pick<LoadedUpdate['meta'], 'origin'>) {
  if (origin?.kind !== 'mcp' || !origin.message) {
    return null
  }

  return (
    <div
      className="history-version-message"
      data-testid="history-version-message"
      title={origin.message}
    >
      {origin.message}
    </div>
  )
}

export default HistoryVersionMessage
