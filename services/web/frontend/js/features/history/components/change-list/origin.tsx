import { useTranslation } from 'react-i18next'
import { LoadedUpdate } from '../../services/types/update'

function Origin({ origin }: Pick<LoadedUpdate['meta'], 'origin'>) {
  const { t } = useTranslation()

  let result: string | null = null
  if (origin?.kind === 'dropbox') result = t('history_entry_origin_dropbox')
  if (origin?.kind === 'upload') result = t('history_entry_origin_upload')
  if (origin?.kind === 'git-bridge') result = t('history_entry_origin_git')
  if (origin?.kind === 'github') result = t('history_entry_origin_github')
  if (origin?.kind === 'mcp') {
    // The MCP client reports its own name, so a write can say which agent
    // made it. Older versions were stored before the name was kept, and not
    // every client sends one, so fall back to the generic wording.
    result = origin.agent
      ? t('history_entry_origin_agent_named', { agent: origin.agent })
      : t('history_entry_origin_agent')
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
