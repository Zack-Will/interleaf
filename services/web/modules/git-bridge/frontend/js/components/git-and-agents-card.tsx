import { useCallback, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import IntegrationCard from '@/features/integrations-panel/integration-card'
import MaterialIcon from '@/shared/components/material-icon'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLNotification from '@/shared/components/ol/ol-notification'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import { useLayoutContext } from '@/shared/context/layout-context'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'
import { setLabelsOnlyPreference } from '@/features/history/context/history-context'

// The only documentation we can link to from Community Edition.
const AUTH_TOKEN_HELP_URL =
  'https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens'

const TOKEN_PLACEHOLDER = '<token>'

function gitCloneCommand(gitBridgePublicBaseUrl: string, projectId: string) {
  return `git clone ${gitBridgePublicBaseUrl}/${projectId}`
}

function mcpEndpoint(siteUrl: string) {
  return `${siteUrl}/mcp`
}

function mcpAddCommand(siteUrl: string) {
  return `claude mcp add --transport http overleaf ${mcpEndpoint(siteUrl)} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`
}

export default function GitAndAgentsCard() {
  const { t } = useTranslation()
  const [showModal, setShowModal] = useState(false)

  return (
    <>
      <IntegrationCard
        title={t('connect_git_and_agents')}
        description={t('git_clone_this_project')}
        icon={<MaterialIcon type="integration_instructions" />}
        showPaywallBadge={false}
        onClick={() => setShowModal(true)}
      />
      <GitAndAgentsModal show={showModal} onHide={() => setShowModal(false)} />
    </>
  )
}

function GitAndAgentsModal({
  show,
  onHide,
}: {
  show: boolean
  onHide: () => void
}) {
  const { t } = useTranslation()
  const { setView } = useLayoutContext()
  const { write, trackedWrite } = usePermissionsContext()

  const projectId = getMeta('ol-project_id')
  const gitBridgePublicBaseUrl = getMeta('ol-gitBridgePublicBaseUrl')
  const { siteUrl } = getMeta('ol-ExposedSettings')

  const handleViewHistory = useCallback(() => {
    setLabelsOnlyPreference(projectId, true)
    setView('history')
    onHide()
  }, [onHide, projectId, setView])

  return (
    <OLModal show={show} onHide={onHide} data-testid="git-bridge-modal">
      <OLModalHeader>
        <OLModalTitle>{t('connect_git_and_agents')}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        {write ? null : (
          <OLNotification
            type="warning"
            content={
              trackedWrite ? (
                <Trans
                  i18nKey="git_bridge_modal_review_access"
                  components={{ 0: <strong /> }}
                />
              ) : (
                <Trans
                  i18nKey="git_bridge_modal_read_only"
                  components={{ strong: <strong /> }}
                />
              )
            }
          />
        )}
        <p>{t('git_bridge_modal_git_clone_your_project')}</p>
        <Snippet
          label={t('git_clone_project_command')}
          snippet={gitCloneCommand(gitBridgePublicBaseUrl, projectId)}
          tooltipId="copy-git-clone-command"
        />
        <p>{t('connect_git_and_agents_description')}</p>
        <Snippet
          label={t('mcp_endpoint')}
          snippet={mcpEndpoint(siteUrl)}
          tooltipId="copy-mcp-endpoint"
        />
        <Snippet
          label={t('add_mcp_server_command')}
          snippet={mcpAddCommand(siteUrl)}
          tooltipId="copy-mcp-add-command"
        />
        <p>
          <Trans
            i18nKey="git_bridge_modal_use_previous_token"
            components={{
              0: (
                // eslint-disable-next-line jsx-a11y/anchor-has-content
                <a
                  href={AUTH_TOKEN_HELP_URL}
                  target="_blank"
                  rel="noreferrer"
                />
              ),
            }}
          />
        </p>
        <p>{t('agent_and_git_changes_are_labelled_in_history')}</p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton
          variant="secondary"
          href="/user/settings"
          target="_blank"
          rel="noreferrer"
        >
          {t('go_to_settings')}
        </OLButton>
        <OLButton variant="primary" onClick={handleViewHistory}>
          {t('view_change_history')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}

function Snippet({
  label,
  snippet,
  tooltipId,
}: {
  label: string
  snippet: string
  tooltipId: string
}) {
  return (
    <OLFormGroup>
      <OLFormLabel>{label}</OLFormLabel>
      <div className="command-snippet">
        <code aria-label={label} translate="no">
          {snippet}
        </code>
        <CopyToClipboard content={snippet} tooltipId={tooltipId} />
      </div>
    </OLFormGroup>
  )
}
