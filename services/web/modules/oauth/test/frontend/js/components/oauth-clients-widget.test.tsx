import { expect } from 'chai'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import fetchMock from 'fetch-mock'
import OAuthClientsWidget from '../../../../frontend/js/components/oauth-clients-widget'

const existingClient = {
  clientId: 'olo_0123456789abcdef01234567',
  name: 'Claude',
  redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
  createdAt: '2026-11-01T00:00:00.000Z',
  lastUsedAt: null,
}

describe('<OAuthClientsWidget />', function () {
  beforeEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  afterEach(function () {
    fetchMock.removeRoutes().clearHistory()
  })

  it('lists the user’s OAuth apps', async function () {
    fetchMock.get('/user/oauth-clients', [existingClient])
    render(<OAuthClientsWidget />)

    await screen.findByText('olo_0123456789abcdef01234567')
    screen.getByText('Claude')
    screen.getByRole('button', { name: 'Delete' })
  })

  it('creates an app with the Claude callbacks and shows the secret once', async function () {
    fetchMock.get('/user/oauth-clients', [])
    const createMock = fetchMock.post('/user/oauth-clients', {
      status: 200,
      body: {
        ...existingClient,
        clientSecret: 'ols_SECRET',
      },
    })

    render(<OAuthClientsWidget />)
    await screen.findByText('You have no OAuth apps.')

    fireEvent.click(
      screen.getByRole('button', { name: 'OAuth apps Create OAuth app' })
    )
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('Name'), {
      target: { value: 'Claude' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(
      () =>
        expect(createMock.callHistory.called(true, { method: 'post' })).to.be
          .true
    )
    const [{ options }] = createMock.callHistory.calls(true, {
      method: 'post',
    })
    expect(JSON.parse(String(options.body))).to.deep.equal({
      name: 'Claude',
      redirectUris: [
        'https://claude.ai/api/mcp/auth_callback',
        'https://claude.com/api/mcp/auth_callback',
      ],
    })

    const secret = (await screen.findByLabelText(
      'Client secret'
    )) as HTMLInputElement
    expect(secret.value).to.equal('ols_SECRET')
    expect(
      (screen.getByLabelText('MCP server URL') as HTMLInputElement).value
    ).to.equal('https://www.dev-overleaf.com/mcp')

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    await waitFor(
      () => expect(screen.queryByDisplayValue('ols_SECRET')).to.be.null
    )
    screen.getByText('olo_0123456789abcdef01234567')
  })

  it('deletes an app after confirmation', async function () {
    fetchMock.get('/user/oauth-clients', [existingClient])
    const deleteMock = fetchMock.delete(
      '/user/oauth-clients/olo_0123456789abcdef01234567',
      { status: 204 }
    )

    render(<OAuthClientsWidget />)
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
    await screen.findByText(/Deleting Claude disconnects/)
    fireEvent.click(screen.getByTestId('delete-oauth-app-confirm'))

    await waitFor(() => expect(deleteMock.callHistory.called()).to.be.true)
    await waitFor(
      () =>
        expect(screen.queryByText('olo_0123456789abcdef01234567')).to.be.null
    )
  })
})
