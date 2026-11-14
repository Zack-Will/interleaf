import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import {
  deleteJSON,
  getJSON,
  postJSON,
  getUserFacingMessage,
} from '@/infrastructure/fetch-json'
import { formatDate, fromNowDate } from '@/utils/dates'
import MaterialIcon from '@/shared/components/material-icon'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormText from '@/shared/components/ol/ol-form-text'
import Notification from '@/shared/components/notification'
import OLTable from '@/shared/components/ol/ol-table'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'

// Claude's custom connectors return to one of these after authorization.
const DEFAULT_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://claude.com/api/mcp/auth_callback',
]

type OAuthClient = {
  clientId: string
  name: string
  redirectUris: string[]
  createdAt: string
  lastUsedAt: string | null
}

type CreatedOAuthClient = OAuthClient & { clientSecret: string }

function parseRedirectUris(value: string) {
  return value
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
}

export default function OAuthClientsWidget() {
  const { t } = useTranslation()
  const { siteUrl } = getMeta('ol-ExposedSettings')

  const [clients, setClients] = useState<OAuthClient[]>([])
  const [errorMessage, setErrorMessage] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [clientToDelete, setClientToDelete] = useState<OAuthClient | null>(null)

  useEffect(() => {
    getJSON<OAuthClient[]>('/user/oauth-clients')
      .then(setClients)
      .catch(error => setErrorMessage(getUserFacingMessage(error) ?? ''))
  }, [])

  const handleCreated = useCallback((created: CreatedOAuthClient) => {
    // The secret is shown in the modal once and never kept in the list.
    const { clientSecret: _clientSecret, ...client } = created
    setClients(previous => [client, ...previous])
  }, [])

  const handleDeleted = useCallback((clientId: string) => {
    setClients(previous =>
      previous.filter(client => client.clientId !== clientId)
    )
  }, [])

  return (
    <div className="settings-widget-container">
      <div className="linking-icon-fixed-position">
        <MaterialIcon type="key" size="2x" />
      </div>
      <div className="description-container">
        <div className="title-row">
          <h4 id="oauth-apps">{t('oauth_apps')}</h4>
        </div>
        <p className="small">{t('oauth_apps_description')}</p>
        {errorMessage ? (
          <div className="notification-list">
            <Notification type="error" content={errorMessage} />
          </div>
        ) : null}
        {clients.length === 0 ? (
          <p className="small">{t('no_oauth_apps')}</p>
        ) : (
          <ClientList clients={clients} onDeleteClick={setClientToDelete} />
        )}
      </div>
      <div>
        <OLButton
          variant="secondary"
          id="create-oauth-app"
          aria-labelledby="oauth-apps create-oauth-app"
          onClick={() => {
            setErrorMessage('')
            setShowCreateModal(true)
          }}
        >
          {t('create_oauth_app')}
        </OLButton>
      </div>
      <CreateClientModal
        show={showCreateModal}
        siteUrl={siteUrl}
        onHide={() => setShowCreateModal(false)}
        onCreated={handleCreated}
      />
      <DeleteClientModal
        client={clientToDelete}
        onHide={() => setClientToDelete(null)}
        onDeleted={handleDeleted}
        onError={setErrorMessage}
      />
    </div>
  )
}

function ClientList({
  clients,
  onDeleteClick,
}: {
  clients: OAuthClient[]
  onDeleteClick: (client: OAuthClient) => void
}) {
  const { t } = useTranslation()

  return (
    <OLTable responsive className="oauth-clients-table">
      <thead>
        <tr>
          <th scope="col">{t('name')}</th>
          <th scope="col">{t('oauth_client_id')}</th>
          <th scope="col">{t('created')}</th>
          <th scope="col">{t('last_used')}</th>
          <th scope="col">
            <span className="visually-hidden">{t('actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {clients.map(client => (
          <tr key={client.clientId}>
            <td>{client.name}</td>
            <td translate="no">
              <code>{client.clientId}</code>
            </td>
            <td>{formatDate(client.createdAt, 'Do MMM YYYY')}</td>
            <td>{client.lastUsedAt ? fromNowDate(client.lastUsedAt) : '—'}</td>
            <td>
              <OLButton
                variant="danger-ghost"
                size="sm"
                onClick={() => onDeleteClick(client)}
              >
                {t('delete')}
              </OLButton>
            </td>
          </tr>
        ))}
      </tbody>
    </OLTable>
  )
}

function CreateClientModal({
  show,
  siteUrl,
  onHide,
  onCreated,
}: {
  show: boolean
  siteUrl: string
  onHide: () => void
  onCreated: (client: CreatedOAuthClient) => void
}) {
  const { t } = useTranslation()

  const [name, setName] = useState('')
  const [redirectUris, setRedirectUris] = useState(
    DEFAULT_REDIRECT_URIS.join('\n')
  )
  const [inflight, setInflight] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [created, setCreated] = useState<CreatedOAuthClient | null>(null)

  const reset = useCallback(() => {
    setName('')
    setRedirectUris(DEFAULT_REDIRECT_URIS.join('\n'))
    setInflight(false)
    setErrorMessage('')
    setCreated(null)
  }, [])

  const handleHide = useCallback(() => {
    onHide()
    reset()
  }, [onHide, reset])

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      setInflight(true)
      setErrorMessage('')
      postJSON<CreatedOAuthClient>('/user/oauth-clients', {
        body: { name, redirectUris: parseRedirectUris(redirectUris) },
      })
        .then(response => {
          setCreated(response)
          onCreated(response)
        })
        .catch(error => {
          setErrorMessage(getUserFacingMessage(error) ?? '')
        })
        .finally(() => {
          setInflight(false)
        })
    },
    [name, onCreated, redirectUris]
  )

  return (
    <OLModal show={show} onHide={handleHide}>
      <OLModalHeader>
        <OLModalTitle>{t('create_oauth_app')}</OLModalTitle>
      </OLModalHeader>
      {created ? (
        <>
          <OLModalBody>
            <CreatedClientDetails created={created} siteUrl={siteUrl} />
          </OLModalBody>
          <OLModalFooter>
            <OLButton variant="primary" onClick={handleHide}>
              {t('close')}
            </OLButton>
          </OLModalFooter>
        </>
      ) : (
        <form onSubmit={handleSubmit}>
          <OLModalBody>
            {errorMessage ? (
              <div className="notification-list">
                <Notification type="error" content={errorMessage} />
              </div>
            ) : null}
            <OLFormGroup controlId="oauth-app-name">
              <OLFormLabel>{t('name')}</OLFormLabel>
              <OLFormControl
                type="text"
                required
                maxLength={100}
                value={name}
                placeholder={t('oauth_app_name_placeholder')}
                onChange={event => setName(event.target.value)}
              />
            </OLFormGroup>
            <OLFormGroup controlId="oauth-app-redirect-uris">
              <OLFormLabel>{t('oauth_redirect_uris')}</OLFormLabel>
              <OLFormControl
                as="textarea"
                rows={3}
                required
                translate="no"
                value={redirectUris}
                onChange={event => setRedirectUris(event.target.value)}
              />
              <OLFormText>{t('oauth_redirect_uris_help')}</OLFormText>
            </OLFormGroup>
          </OLModalBody>
          <OLModalFooter>
            <OLButton variant="secondary" onClick={handleHide}>
              {t('cancel')}
            </OLButton>
            <OLButton variant="primary" type="submit" disabled={inflight}>
              {inflight ? t('creating') : t('create')}
            </OLButton>
          </OLModalFooter>
        </form>
      )}
    </OLModal>
  )
}

function CreatedClientDetails({
  created,
  siteUrl,
}: {
  created: CreatedOAuthClient
  siteUrl: string
}) {
  const { t } = useTranslation()

  return (
    <>
      <CopyableField
        controlId="oauth-mcp-server-url"
        label={t('oauth_mcp_server_url')}
        value={`${siteUrl}/mcp`}
      />
      <CopyableField
        controlId="oauth-client-id"
        label={t('oauth_client_id')}
        value={created.clientId}
      />
      <CopyableField
        controlId="oauth-client-secret"
        label={t('oauth_client_secret')}
        value={created.clientSecret}
      />
      <div className="notification-list">
        <Notification type="warning" content={t('oauth_client_secret_once')} />
      </div>
    </>
  )
}

function CopyableField({
  controlId,
  label,
  value,
}: {
  controlId: string
  label: string
  value: string
}) {
  return (
    <OLFormGroup controlId={controlId}>
      <OLFormLabel>{label}</OLFormLabel>
      <OLFormControl
        type="text"
        readOnly
        value={value}
        translate="no"
        append={
          <CopyToClipboard content={value} tooltipId={`${controlId}-copy`} />
        }
      />
    </OLFormGroup>
  )
}

function DeleteClientModal({
  client,
  onHide,
  onDeleted,
  onError,
}: {
  client: OAuthClient | null
  onHide: () => void
  onDeleted: (clientId: string) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [inflight, setInflight] = useState(false)

  const handleConfirm = useCallback(() => {
    if (!client) {
      return
    }
    setInflight(true)
    deleteJSON(`/user/oauth-clients/${client.clientId}`)
      .then(() => {
        onDeleted(client.clientId)
        onHide()
      })
      .catch(error => {
        onError(getUserFacingMessage(error) ?? '')
        onHide()
      })
      .finally(() => {
        setInflight(false)
      })
  }, [client, onDeleted, onError, onHide])

  return (
    <OLModal show={Boolean(client)} onHide={onHide}>
      <OLModalHeader>
        <OLModalTitle>{t('delete_oauth_app')}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>
          {t('delete_oauth_app_warning', { name: client ? client.name : '' })}
        </p>
      </OLModalBody>
      <OLModalFooter>
        <OLButton variant="secondary" onClick={onHide}>
          {t('cancel')}
        </OLButton>
        <OLButton
          variant="danger"
          onClick={handleConfirm}
          disabled={inflight}
          data-testid="delete-oauth-app-confirm"
        >
          {t('delete')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
