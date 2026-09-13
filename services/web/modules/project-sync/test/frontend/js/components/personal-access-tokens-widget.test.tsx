import { expect } from 'chai'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import PersonalAccessTokensWidget from '../../../../frontend/js/components/personal-access-tokens-widget'
import type { AccessToken } from '../../../../../../types/settings-page'

const gitToken: AccessToken = {
  id: 'token-git',
  tokenPrefix: 'olp_abcd',
  scopes: ['git_bridge'],
  label: 'Laptop',
  createdAt: '2026-01-02T00:00:00.000Z',
  expiresAt: null,
  lastUsedAt: null,
}

const agentToken: AccessToken = {
  id: 'token-agent',
  tokenPrefix: 'olp_wxyz',
  scopes: ['git_bridge', 'mcp'],
  label: 'Claude',
  createdAt: '2026-02-03T00:00:00.000Z',
  expiresAt: '2026-05-04T00:00:00.000Z',
  lastUsedAt: '2026-02-04T00:00:00.000Z',
}

function setTokensMeta(tokens: AccessToken[]) {
  window.metaAttributesCache.set('ol-personalAccessTokens', tokens)
}

function openGenerateModal() {
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Personal access tokens Generate token',
    })
  )
}

describe('<PersonalAccessTokensWidget />', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('renders the tokens from the page meta', async function () {
    setTokensMeta([gitToken, agentToken])
    render(<PersonalAccessTokensWidget />)

    await screen.findByRole('heading', { name: 'Personal access tokens' })

    screen.getByText('olp_abcd************')
    screen.getByText('olp_wxyz************')
    screen.getByText('Laptop')
    screen.getByText('Claude')
    expect(screen.getAllByText('Git')).to.have.length(2)
    screen.getByText('Agent (MCP)')
    expect(screen.getAllByRole('button', { name: 'Revoke' })).to.have.length(2)
  })

  it('renders an empty state when the user has no tokens', async function () {
    setTokensMeta([])
    render(<PersonalAccessTokensWidget />)

    await screen.findByText('This user has no personal access tokens')
    expect(screen.queryByRole('table')).to.be.null
  })

  it('generates a token and shows it exactly once', async function () {
    setTokensMeta([])
    const createMock = fetchMock.post('/user/personal-access-tokens', {
      status: 200,
      body: {
        token: 'olp_ABCDEFGHIJKLMNOP',
        id: 'token-new',
        tokenPrefix: 'olp_ABCD',
        scopes: ['git_bridge', 'mcp'],
        label: 'My agent',
        createdAt: '2026-09-12T00:00:00.000Z',
        expiresAt: null,
        lastUsedAt: null,
      },
    })

    render(<PersonalAccessTokensWidget />)
    await screen.findByText('This user has no personal access tokens')

    openGenerateModal()

    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Label'), {
      target: { value: 'My agent' },
    })
    expect((within(dialog).getByLabelText('Git') as HTMLInputElement).checked)
      .to.be.true
    expect(
      (within(dialog).getByLabelText('Agent (MCP)') as HTMLInputElement).checked
    ).to.be.true
    fireEvent.change(within(dialog).getByLabelText('Expiry'), {
      target: { value: '90' },
    })
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Generate token' })
    )

    await waitFor(() => expect(createMock.callHistory.called()).to.be.true)

    const { options } = createMock.callHistory.calls()[0]
    expect(JSON.parse(String(options.body))).to.deep.equal({
      label: 'My agent',
      scopes: ['git_bridge', 'mcp'],
      expiresInDays: 90,
    })

    const tokenInput = (await screen.findByLabelText(
      'Token'
    )) as HTMLInputElement
    expect(tokenInput.value).to.equal('olp_ABCDEFGHIJKLMNOP')
    expect(tokenInput.readOnly).to.be.true
    screen.getByText(/You’ll only see this token once/)
    screen.getByLabelText('Use this token with Git')
    const mcpSnippet = screen.getByLabelText('Use this token with an AI agent')
    expect(mcpSnippet.textContent).to.equal(
      'claude mcp add --transport http overleaf https://www.dev-overleaf.com/mcp --header "Authorization: Bearer olp_ABCDEFGHIJKLMNOP"'
    )

    // Closing the modal adds the new token to the list, masked, and the raw
    // token is gone for good.
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))

    await waitFor(
      () =>
        expect(screen.queryByDisplayValue('olp_ABCDEFGHIJKLMNOP')).to.be.null
    )
    screen.getByText('olp_ABCD************')
  })

  it('does not submit without a scope', async function () {
    setTokensMeta([])
    const createMock = fetchMock.post('/user/personal-access-tokens', {
      status: 200,
      body: {},
    })

    render(<PersonalAccessTokensWidget />)
    await screen.findByText('This user has no personal access tokens')

    openGenerateModal()
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByLabelText('Git'))
    fireEvent.click(within(dialog).getByLabelText('Agent (MCP)'))
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Generate token' })
    )

    await within(dialog).findByText('Select at least one scope.')
    expect(createMock.callHistory.called()).to.be.false
  })

  it('revokes a token after confirmation', async function () {
    setTokensMeta([gitToken, agentToken])
    const revokeMock = fetchMock.delete(
      '/user/personal-access-tokens/token-git',
      { status: 204 }
    )

    render(<PersonalAccessTokensWidget />)
    await screen.findByText('olp_abcd************')

    fireEvent.click(screen.getAllByRole('button', { name: 'Revoke' })[0])

    await screen.findByRole('heading', {
      name: 'Revoke personal access token',
    })
    screen.getByText(/olp_abcd\*+ will immediately lose access/)

    fireEvent.click(screen.getByTestId('revoke-personal-access-token-confirm'))

    await waitFor(() => expect(revokeMock.callHistory.called()).to.be.true)
    await waitFor(
      () => expect(screen.queryByText('olp_abcd************')).to.be.null
    )
    screen.getByText('olp_wxyz************')
  })

  it('shows an error notification when revoking fails', async function () {
    setTokensMeta([gitToken])
    fetchMock.delete('/user/personal-access-tokens/token-git', { status: 500 })

    render(<PersonalAccessTokensWidget />)
    await screen.findByText('olp_abcd************')

    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
    await screen.findByRole('heading', {
      name: 'Revoke personal access token',
    })
    fireEvent.click(screen.getByTestId('revoke-personal-access-token-confirm'))

    await screen.findByRole('alert')
    screen.getByText('olp_abcd************')
  })
})
