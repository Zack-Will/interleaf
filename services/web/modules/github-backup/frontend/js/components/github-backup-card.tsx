import { useCallback, useEffect, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import IntegrationCard from '@/features/integrations-panel/integration-card'
import MaterialIcon from '@/shared/components/material-icon'
import {
  deleteJSON,
  getJSON,
  postJSON,
  getUserFacingMessage,
} from '@/infrastructure/fetch-json'
import { formatDate, fromNowDate } from '@/utils/dates'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormText from '@/shared/components/ol/ol-form-text'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLTag from '@/shared/components/ol/ol-tag'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import { usePermissionsContext } from '@/features/ide-react/context/permissions-context'

const TOKEN_HELP_URL = 'https://github.com/settings/personal-access-tokens/new'

const POLL_INTERVAL_MS = 5000

type BackupState = 'idle' | 'syncing' | 'ok' | 'error' | 'diverged'

type BackupStatus = {
  linked: boolean
  owner?: string
  repo?: string
  branch?: string
  repoUrl?: string
  status?: BackupState
  lastSyncedVersion?: number | null
  lastSyncedAt?: string | null
  lastPushedCommit?: string | null
  lastError?: { code: string; message: string; at?: string } | null
  inProgress?: boolean
}

const TAG_VARIANT: Record<BackupState, string> = {
  idle: 'light',
  syncing: 'info',
  ok: 'success',
  error: 'danger',
  diverged: 'warning',
}

function statusUrl(projectId: string) {
  return `/project/${projectId}/github-backup`
}

export default function GithubBackupCard() {
  const { t } = useTranslation()
  const [showModal, setShowModal] = useState(false)
  const enabled = getMeta('ol-githubBackupEnabled')

  if (!enabled) {
    return null
  }

  return (
    <>
      <IntegrationCard
        title={t('back_up_to_github')}
        description={t('back_up_to_github_description')}
        icon={<MaterialIcon type="cloud_upload" />}
        showPaywallBadge={false}
        onClick={() => setShowModal(true)}
      />
      <GithubBackupModal show={showModal} onHide={() => setShowModal(false)} />
    </>
  )
}

function GithubBackupModal({
  show,
  onHide,
}: {
  show: boolean
  onHide: () => void
}) {
  const { t } = useTranslation()
  const { write, admin } = usePermissionsContext()
  const projectId = getMeta('ol-project_id')

  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [errorMessage, setErrorMessage] = useState('')
  const [inflight, setInflight] = useState(false)
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false)

  const refresh = useCallback(() => {
    return getJSON<BackupStatus>(statusUrl(projectId))
      .then(setStatus)
      .catch(error => setErrorMessage(getUserFacingMessage(error) ?? ''))
  }, [projectId])

  useEffect(() => {
    if (!show) return
    setErrorMessage('')
    refresh()
  }, [refresh, show])

  // A backup started elsewhere (the scheduler, another collaborator) finishes
  // without telling the browser, so a running one is polled to completion.
  useEffect(() => {
    if (!show || status?.status !== 'syncing') return
    const timer = setInterval(refresh, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [refresh, show, status?.status])

  const handleBackupNow = useCallback(() => {
    setInflight(true)
    setErrorMessage('')
    postJSON<BackupStatus>(`${statusUrl(projectId)}/sync`)
      .then(setStatus)
      .catch(error => setErrorMessage(getUserFacingMessage(error) ?? ''))
      .finally(() => setInflight(false))
  }, [projectId])

  const handleDisconnect = useCallback(() => {
    setInflight(true)
    setErrorMessage('')
    deleteJSON(statusUrl(projectId))
      .then(() => setStatus({ linked: false }))
      .catch(error => setErrorMessage(getUserFacingMessage(error) ?? ''))
      .finally(() => {
        setInflight(false)
        setConfirmingDisconnect(false)
      })
  }, [projectId])

  return (
    <>
      <OLModal show={show} onHide={onHide} data-testid="github-backup-modal">
        <OLModalHeader>
          <OLModalTitle>{t('back_up_to_github')}</OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          {errorMessage ? (
            <OLNotification type="error" content={errorMessage} />
          ) : null}
          {status == null ? (
            <p>{t('loading')}…</p>
          ) : status.linked ? (
            <LinkedBackup status={status} />
          ) : admin ? (
            <ConnectForm
              projectId={projectId}
              onConnected={setStatus}
              onError={setErrorMessage}
            />
          ) : (
            <OLNotification
              type="info"
              content={t('github_backup_owner_only')}
            />
          )}
        </OLModalBody>
        <OLModalFooter>
          <OLButton variant="secondary" onClick={onHide}>
            {t('close')}
          </OLButton>
          {status?.linked && write ? (
            <OLButton
              variant="primary"
              onClick={handleBackupNow}
              disabled={inflight || status.status === 'syncing'}
            >
              {t('github_backup_back_up_now')}
            </OLButton>
          ) : null}
          {status?.linked && admin ? (
            <OLButton
              variant="danger-ghost"
              onClick={() => setConfirmingDisconnect(true)}
              disabled={inflight}
            >
              {t('github_backup_disconnect')}
            </OLButton>
          ) : null}
        </OLModalFooter>
      </OLModal>
      <OLModal
        show={confirmingDisconnect}
        onHide={() => setConfirmingDisconnect(false)}
        data-testid="github-backup-disconnect-modal"
      >
        <OLModalHeader>
          <OLModalTitle>{t('github_backup_disconnect')}</OLModalTitle>
        </OLModalHeader>
        <OLModalBody>
          <p>
            {t('github_backup_disconnect_warning', {
              repository: `${status?.owner}/${status?.repo}`,
            })}
          </p>
        </OLModalBody>
        <OLModalFooter>
          <OLButton
            variant="secondary"
            onClick={() => setConfirmingDisconnect(false)}
          >
            {t('cancel')}
          </OLButton>
          <OLButton
            variant="danger"
            onClick={handleDisconnect}
            disabled={inflight}
            data-testid="github-backup-disconnect-confirm"
          >
            {t('github_backup_disconnect')}
          </OLButton>
        </OLModalFooter>
      </OLModal>
    </>
  )
}

function LinkedBackup({ status }: { status: BackupStatus }) {
  const { t } = useTranslation()
  const state: BackupState = status.status ?? 'idle'

  const stateLabels: Record<BackupState, string> = {
    idle: t('github_backup_state_idle'),
    syncing: t('github_backup_state_syncing'),
    ok: t('github_backup_state_ok'),
    error: t('github_backup_state_error'),
    diverged: t('github_backup_state_diverged'),
  }

  return (
    <>
      <OLFormGroup>
        <OLFormLabel>{t('github_backup_repository')}</OLFormLabel>
        <div>
          <a href={status.repoUrl} target="_blank" rel="noreferrer">
            {status.owner}/{status.repo}
          </a>{' '}
          <span translate="no">({status.branch})</span>
        </div>
      </OLFormGroup>
      <OLFormGroup>
        <OLFormLabel>{t('github_backup_state')}</OLFormLabel>
        <div>
          <OLTag bg={TAG_VARIANT[state]}>{stateLabels[state]}</OLTag>
        </div>
      </OLFormGroup>
      <p>
        {status.lastSyncedAt ? (
          <span title={formatDate(status.lastSyncedAt)}>
            {t('github_backup_last_backed_up', {
              when: fromNowDate(status.lastSyncedAt),
              version: status.lastSyncedVersion ?? '?',
            })}
          </span>
        ) : (
          t('github_backup_never_backed_up')
        )}
      </p>
      {status.lastError ? (
        <OLNotification
          type={state === 'diverged' ? 'warning' : 'error'}
          content={status.lastError.message}
        />
      ) : null}
    </>
  )
}

function ConnectForm({
  projectId,
  onConnected,
  onError,
}: {
  projectId: string
  onConnected: (status: BackupStatus) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('main')
  const [token, setToken] = useState('')
  const [createIfMissing, setCreateIfMissing] = useState(false)
  const [inflight, setInflight] = useState(false)

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setInflight(true)
      onError('')
      postJSON<BackupStatus>(statusUrl(projectId), {
        body: { repository, branch, token, createIfMissing },
      })
        .then(onConnected)
        .catch(error => onError(getUserFacingMessage(error) ?? ''))
        .finally(() => setInflight(false))
    },
    [
      branch,
      createIfMissing,
      onConnected,
      onError,
      projectId,
      repository,
      token,
    ]
  )

  return (
    <form onSubmit={handleSubmit} data-testid="github-backup-connect-form">
      <p>{t('github_backup_not_connected')}</p>
      <OLFormGroup controlId="github-backup-repository">
        <OLFormLabel>{t('github_backup_repository')}</OLFormLabel>
        <OLFormControl
          type="text"
          value={repository}
          placeholder="owner/repository"
          onChange={event => setRepository(event.target.value)}
          required
        />
      </OLFormGroup>
      <OLFormGroup controlId="github-backup-branch">
        <OLFormLabel>{t('github_backup_branch')}</OLFormLabel>
        <OLFormControl
          type="text"
          value={branch}
          onChange={event => setBranch(event.target.value)}
          required
        />
      </OLFormGroup>
      <OLFormGroup controlId="github-backup-token">
        <OLFormLabel>{t('github_backup_token')}</OLFormLabel>
        <OLFormControl
          type="password"
          value={token}
          onChange={event => setToken(event.target.value)}
          required
        />
        <OLFormText>
          <Trans
            i18nKey="github_backup_token_hint"
            components={{
              0: (
                // eslint-disable-next-line jsx-a11y/anchor-has-content
                <a href={TOKEN_HELP_URL} target="_blank" rel="noreferrer" />
              ),
            }}
          />
        </OLFormText>
      </OLFormGroup>
      <OLFormGroup>
        <OLFormCheckbox
          id="github-backup-create-repository"
          label={t('github_backup_create_repository')}
          checked={createIfMissing}
          onChange={() => setCreateIfMissing(previous => !previous)}
        />
      </OLFormGroup>
      <OLButton variant="primary" type="submit" disabled={inflight}>
        {inflight ? t('github_backup_connecting') : t('github_backup_connect')}
      </OLButton>
    </form>
  )
}
