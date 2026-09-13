import { useCallback, useMemo, useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import getMeta from '@/utils/meta'
import {
  deleteJSON,
  postJSON,
  getUserFacingMessage,
} from '@/infrastructure/fetch-json'
import { formatDate, fromNowDate } from '@/utils/dates'
import MaterialIcon from '@/shared/components/material-icon'
import { CopyToClipboard } from '@/shared/components/copy-to-clipboard'
import OLButton from '@/shared/components/ol/ol-button'
import OLFormCheckbox from '@/shared/components/ol/ol-form-checkbox'
import OLFormControl from '@/shared/components/ol/ol-form-control'
import OLFormGroup from '@/shared/components/ol/ol-form-group'
import OLFormLabel from '@/shared/components/ol/ol-form-label'
import OLFormSelect from '@/shared/components/ol/ol-form-select'
import OLNotification from '@/shared/components/ol/ol-notification'
import OLTable from '@/shared/components/ol/ol-table'
import OLTag from '@/shared/components/ol/ol-tag'
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from '@/shared/components/ol/ol-modal'
import type {
  AccessToken,
  AccessTokenScope,
} from '../../../../../types/settings-page'

// The only documentation we can link to from Community Edition. Kept in one
// place so that the settings widget and the editor modal stay in sync.
const AUTH_TOKEN_HELP_URL =
  'https://docs.overleaf.com/integrations-and-add-ons/git-integration-and-github-synchronization/git-integration/git-integration-authentication-tokens'

const EXPIRY_OPTIONS = [null, 30, 90, 365] as const

const ALL_SCOPES: AccessTokenScope[] = ['git_bridge', 'mcp']

type GeneratedToken = AccessToken & { token: string }

function maskToken(tokenPrefix: string) {
  return `${tokenPrefix}************`
}

function gitRemoteUrl(siteUrl: string) {
  return `${siteUrl}/git/<project-id>`
}

function gitCloneSnippet(siteUrl: string) {
  return `git clone ${gitRemoteUrl(siteUrl)}`
}

function mcpSnippet(siteUrl: string, token: string) {
  return `claude mcp add --transport http overleaf ${siteUrl}/mcp --header "Authorization: Bearer ${token}"`
}

export default function PersonalAccessTokensWidget() {
  const { t } = useTranslation()
  const { siteUrl } = getMeta('ol-ExposedSettings')

  const [tokens, setTokens] = useState<AccessToken[]>(
    () => getMeta('ol-personalAccessTokens') ?? []
  )
  const [errorMessage, setErrorMessage] = useState('')
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [tokenToRevoke, setTokenToRevoke] = useState<AccessToken | null>(null)

  const handleGenerated = useCallback((generated: GeneratedToken) => {
    // The raw token is shown in the modal and then dropped: only the masked
    // record belongs in the list.
    const { token: _token, ...record } = generated
    setTokens(previous => [record, ...previous])
  }, [])

  const handleRevoked = useCallback((tokenId: string) => {
    setTokens(previous => previous.filter(token => token.id !== tokenId))
  }, [])

  return (
    <div className="settings-widget-container">
      <div className="linking-icon-fixed-position">
        <MaterialIcon type="key" size="2x" />
      </div>
      <div className="description-container">
        <div className="title-row">
          <h4 id="personal-access-tokens">
            {t('user_personal_access_tokens')}
          </h4>
        </div>
        <p className="small">{t('personal_access_tokens_description')}</p>
        {errorMessage ? (
          <OLNotification type="error" content={errorMessage} />
        ) : null}
        {tokens.length === 0 ? (
          <p className="small">{t('no_personal_access_tokens')}</p>
        ) : (
          <TokenList tokens={tokens} onRevokeClick={setTokenToRevoke} />
        )}
      </div>
      <div>
        <OLButton
          variant="secondary"
          id="generate-personal-access-token"
          aria-labelledby="personal-access-tokens generate-personal-access-token"
          onClick={() => {
            setErrorMessage('')
            setShowGenerateModal(true)
          }}
        >
          {t('generate_token')}
        </OLButton>
      </div>
      <GenerateTokenModal
        show={showGenerateModal}
        siteUrl={siteUrl}
        onHide={() => setShowGenerateModal(false)}
        onGenerated={handleGenerated}
      />
      <RevokeTokenModal
        token={tokenToRevoke}
        onHide={() => setTokenToRevoke(null)}
        onRevoked={handleRevoked}
        onError={setErrorMessage}
      />
    </div>
  )
}

function TokenList({
  tokens,
  onRevokeClick,
}: {
  tokens: AccessToken[]
  onRevokeClick: (token: AccessToken) => void
}) {
  const { t } = useTranslation()

  return (
    <OLTable responsive className="personal-access-tokens-table">
      <thead>
        <tr>
          <th scope="col">{t('token')}</th>
          <th scope="col">{t('token_label')}</th>
          <th scope="col">{t('scope')}</th>
          <th scope="col">{t('created')}</th>
          <th scope="col">{t('last_used')}</th>
          <th scope="col">{t('expires')}</th>
          <th scope="col">
            <span className="visually-hidden">{t('actions')}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {tokens.map(token => (
          <tr key={token.id}>
            <td translate="no">
              <code>{maskToken(token.tokenPrefix)}</code>
            </td>
            <td>{token.label || '—'}</td>
            <td>
              <TokenScopes scopes={token.scopes} />
            </td>
            <td>{formatDate(token.createdAt, 'Do MMM YYYY')}</td>
            <td>{token.lastUsedAt ? fromNowDate(token.lastUsedAt) : '—'}</td>
            <td>
              {token.expiresAt
                ? formatDate(token.expiresAt, 'Do MMM YYYY')
                : '—'}
            </td>
            <td>
              <OLButton
                variant="danger-ghost"
                size="sm"
                onClick={() => onRevokeClick(token)}
              >
                {t('revoke')}
              </OLButton>
            </td>
          </tr>
        ))}
      </tbody>
    </OLTable>
  )
}

function TokenScopes({ scopes }: { scopes: AccessTokenScope[] }) {
  const { t } = useTranslation()

  const scopeLabels: Record<AccessTokenScope, string> = {
    git_bridge: t('git'),
    mcp: t('personal_access_token_scope_agent'),
  }

  return (
    <>
      {scopes.map(scope => (
        <OLTag key={scope} className="personal-access-token-scope">
          {scopeLabels[scope] ?? scope}
        </OLTag>
      ))}
    </>
  )
}

function GenerateTokenModal({
  show,
  siteUrl,
  onHide,
  onGenerated,
}: {
  show: boolean
  siteUrl: string
  onHide: () => void
  onGenerated: (token: GeneratedToken) => void
}) {
  const { t } = useTranslation()

  const [label, setLabel] = useState('')
  const [scopes, setScopes] = useState<AccessTokenScope[]>(ALL_SCOPES)
  const [expiresInDays, setExpiresInDays] = useState<number | null>(null)
  const [inflight, setInflight] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [generated, setGenerated] = useState<GeneratedToken | null>(null)

  const expiryLabels = useMemo(
    () =>
      new Map<number | null, string>(
        EXPIRY_OPTIONS.map(days => [
          days,
          days === null
            ? t('token_expiry_never')
            : t('token_expires_in_days', { days }),
        ])
      ),
    [t]
  )

  const reset = useCallback(() => {
    setLabel('')
    setScopes(ALL_SCOPES)
    setExpiresInDays(null)
    setInflight(false)
    setErrorMessage('')
    setGenerated(null)
  }, [])

  const handleHide = useCallback(() => {
    onHide()
    reset()
  }, [onHide, reset])

  const toggleScope = useCallback((scope: AccessTokenScope) => {
    setScopes(previous =>
      previous.includes(scope)
        ? previous.filter(value => value !== scope)
        : [...previous, scope]
    )
  }, [])

  const handleSubmit = useCallback(
    (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (scopes.length === 0) {
        setErrorMessage(t('token_scope_required'))
        return
      }
      setInflight(true)
      setErrorMessage('')
      postJSON<GeneratedToken>('/user/personal-access-tokens', {
        body: {
          label,
          scopes,
          ...(expiresInDays == null ? {} : { expiresInDays }),
        },
      })
        .then(response => {
          setGenerated(response)
          onGenerated(response)
        })
        .catch(error => {
          setErrorMessage(getUserFacingMessage(error) ?? '')
        })
        .finally(() => {
          setInflight(false)
        })
    },
    [expiresInDays, label, onGenerated, scopes, t]
  )

  return (
    <OLModal show={show} onHide={handleHide}>
      <OLModalHeader>
        <OLModalTitle>{t('generate_personal_access_token')}</OLModalTitle>
      </OLModalHeader>
      {generated ? (
        <>
          <OLModalBody>
            <GeneratedTokenDetails generated={generated} siteUrl={siteUrl} />
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
              <OLNotification type="error" content={errorMessage} />
            ) : null}
            <OLFormGroup controlId="personal-access-token-label">
              <OLFormLabel>{t('token_label')}</OLFormLabel>
              <OLFormControl
                type="text"
                value={label}
                placeholder={t('token_label_placeholder')}
                onChange={event => setLabel(event.target.value)}
              />
            </OLFormGroup>
            <OLFormGroup>
              <fieldset>
                <legend className="form-label">{t('scope')}</legend>
                <OLFormCheckbox
                  id="personal-access-token-scope-git-bridge"
                  label={t('git')}
                  checked={scopes.includes('git_bridge')}
                  onChange={() => toggleScope('git_bridge')}
                />
                <OLFormCheckbox
                  id="personal-access-token-scope-mcp"
                  label={t('personal_access_token_scope_agent')}
                  checked={scopes.includes('mcp')}
                  onChange={() => toggleScope('mcp')}
                />
              </fieldset>
            </OLFormGroup>
            <OLFormGroup controlId="personal-access-token-expiry">
              <OLFormLabel>{t('token_expiry')}</OLFormLabel>
              <OLFormSelect
                value={expiresInDays == null ? '' : String(expiresInDays)}
                onChange={event =>
                  setExpiresInDays(
                    event.target.value === ''
                      ? null
                      : Number(event.target.value)
                  )
                }
              >
                {EXPIRY_OPTIONS.map(days => (
                  <option key={String(days)} value={days == null ? '' : days}>
                    {expiryLabels.get(days)}
                  </option>
                ))}
              </OLFormSelect>
            </OLFormGroup>
          </OLModalBody>
          <OLModalFooter>
            <OLButton variant="secondary" onClick={handleHide}>
              {t('cancel')}
            </OLButton>
            <OLButton variant="primary" type="submit" disabled={inflight}>
              {inflight ? t('generating') : t('generate_token')}
            </OLButton>
          </OLModalFooter>
        </form>
      )}
    </OLModal>
  )
}

function GeneratedTokenDetails({
  generated,
  siteUrl,
}: {
  generated: GeneratedToken
  siteUrl: string
}) {
  const { t } = useTranslation()

  return (
    <>
      <OLFormGroup controlId="generated-personal-access-token">
        <OLFormLabel>{t('token')}</OLFormLabel>
        <OLFormControl
          type="text"
          readOnly
          value={generated.token}
          translate="no"
          append={
            <CopyToClipboard
              content={generated.token}
              tooltipId="copy-personal-access-token"
            />
          }
        />
      </OLFormGroup>
      <OLNotification
        type="warning"
        content={
          <Trans
            i18nKey="git_bridge_modal_see_once"
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
        }
      />
      <Snippet
        label={t('use_this_token_with_git')}
        snippet={gitCloneSnippet(siteUrl)}
        tooltipId="copy-git-clone-snippet"
      />
      <Snippet
        label={t('use_this_token_with_an_agent')}
        snippet={mcpSnippet(siteUrl, generated.token)}
        tooltipId="copy-mcp-snippet"
      />
    </>
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

function RevokeTokenModal({
  token,
  onHide,
  onRevoked,
  onError,
}: {
  token: AccessToken | null
  onHide: () => void
  onRevoked: (tokenId: string) => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation()
  const [inflight, setInflight] = useState(false)

  const handleConfirm = useCallback(() => {
    if (!token) {
      return
    }
    setInflight(true)
    deleteJSON(`/user/personal-access-tokens/${token.id}`)
      .then(() => {
        onRevoked(token.id)
        onHide()
      })
      .catch(error => {
        onError(getUserFacingMessage(error) ?? '')
        onHide()
      })
      .finally(() => {
        setInflight(false)
      })
  }, [onError, onHide, onRevoked, token])

  return (
    <OLModal show={Boolean(token)} onHide={onHide}>
      <OLModalHeader>
        <OLModalTitle>{t('revoke_personal_access_token')}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody>
        <p>
          {t('revoke_personal_access_token_warning', {
            tokenPrefix: token ? maskToken(token.tokenPrefix) : '',
          })}
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
          data-testid="revoke-personal-access-token-confirm"
        >
          {t('revoke')}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  )
}
