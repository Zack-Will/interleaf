import { useTranslation } from 'react-i18next'
import MaterialIcon from '@/shared/components/material-icon'
import OLTag from '@/shared/components/ol/ol-tag'
import { LoadedUpdate } from '../../services/types/update'

// Origins that are machine writes: an agent through the MCP endpoint, or a push
// through the git-bridge. They get a badge, so that a human scanning the list
// can tell them apart from their own edits at a glance.
const MACHINE_ORIGIN_ICONS = {
  mcp: 'smart_toy',
  'git-bridge': 'code',
} as const

function isMachineOrigin(
  kind?: string
): kind is keyof typeof MACHINE_ORIGIN_ICONS {
  return kind === 'mcp' || kind === 'git-bridge'
}

function Origin({ origin }: Pick<LoadedUpdate['meta'], 'origin'>) {
  const { t } = useTranslation()

  let result: string | null = null
  if (origin?.kind === 'dropbox') result = t('history_entry_origin_dropbox')
  if (origin?.kind === 'upload') result = t('history_entry_origin_upload')
  if (origin?.kind === 'git-bridge') result = t('history_entry_origin_git')
  if (origin?.kind === 'mcp') result = t('history_entry_origin_agent')
  if (origin?.kind === 'github') result = t('history_entry_origin_github')

  if (!result) {
    return null
  }

  if (isMachineOrigin(origin?.kind)) {
    return (
      <OLTag
        className="history-version-badge history-version-origin-badge"
        data-testid="history-version-origin-badge"
        prepend={<MaterialIcon type={MACHINE_ORIGIN_ICONS[origin.kind]} />}
      >
        ({result})
      </OLTag>
    )
  }

  return <span className="history-version-origin">({result})</span>
}

export default Origin
