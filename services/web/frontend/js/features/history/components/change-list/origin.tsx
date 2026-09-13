import { useTranslation } from 'react-i18next'
import { LoadedUpdate } from '../../services/types/update'

// A change an agent offered as tracked changes is not the same event as one it
// wrote into the document, and the suffix says which it was. The MCP client
// reports its own name, so a write can also say which agent made it; older
// writes were stored before the name was kept, and not every client sends one,
// so each wording has a form without it.
function agentOriginKey(suggestion?: boolean, agent?: string) {
  if (suggestion)
    return agent
      ? 'history_entry_origin_agent_suggestion_named'
      : 'history_entry_origin_agent_suggestion'
  return agent
    ? 'history_entry_origin_agent_named'
    : 'history_entry_origin_agent'
}

function Origin({ origin }: Pick<LoadedUpdate['meta'], 'origin'>) {
  const { t } = useTranslation()

  let result: string | null = null
  if (origin?.kind === 'dropbox') result = t('history_entry_origin_dropbox')
  if (origin?.kind === 'upload') result = t('history_entry_origin_upload')
  if (origin?.kind === 'git-bridge') result = t('history_entry_origin_git')
  if (origin?.kind === 'github') result = t('history_entry_origin_github')
  if (origin?.kind === 'mcp') {
    result = t(agentOriginKey(origin.suggestion, origin.agent), {
      agent: origin.agent,
    })
  }

  if (!result) {
    return null
  }

  return (
    <span
      className="history-version-origin"
      data-testid="history-version-origin"
    >
      ({result})
    </span>
  )
}

export default Origin
