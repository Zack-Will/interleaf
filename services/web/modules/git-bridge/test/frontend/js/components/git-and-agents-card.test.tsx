import { expect } from 'chai'
import { fireEvent, render, screen } from '@testing-library/react'
import sinon from 'sinon'
import { PermissionsContext } from '@/features/ide-react/context/permissions-context'
import { LayoutContext } from '@/shared/context/layout-context'
import type { Permissions } from '@/features/ide-react/types/permissions'
import type { LayoutContextValue } from '@/shared/context/layout-context'
import localStorage from '@/infrastructure/local-storage'
import GitAndAgentsCard from '../../../../frontend/js/components/git-and-agents-card'

const PROJECT_ID = '63e21c07946dd8c76505f85a'
const GIT_BRIDGE_BASE_URL = 'https://www.dev-overleaf.com/git'

const readAndWrite: Permissions = {
  read: true,
  comment: true,
  resolveOwnComments: true,
  resolveAllComments: true,
  trackedWrite: true,
  write: true,
  admin: false,
  labelVersion: true,
}

const reviewOnly: Permissions = { ...readAndWrite, write: false, admin: false }

const readOnly: Permissions = {
  ...reviewOnly,
  trackedWrite: false,
  resolveOwnComments: false,
  resolveAllComments: false,
  labelVersion: false,
}

function renderCard(permissions: Permissions, setView = sinon.stub()) {
  const layout = { setView } as unknown as LayoutContextValue

  render(
    <LayoutContext.Provider value={layout}>
      <PermissionsContext.Provider value={permissions}>
        <GitAndAgentsCard />
      </PermissionsContext.Provider>
    </LayoutContext.Provider>
  )
}

async function openModal() {
  fireEvent.click(await screen.findByText('Connect Git and agents'))
  return screen.findByTestId('git-bridge-modal')
}

describe('<GitAndAgentsCard />', function () {
  beforeEach(function () {
    window.metaAttributesCache.set('ol-project_id', PROJECT_ID)
    window.metaAttributesCache.set(
      'ol-gitBridgePublicBaseUrl',
      GIT_BRIDGE_BASE_URL
    )
    localStorage.clear()
  })

  afterEach(function () {
    localStorage.clear()
  })

  it('shows the exact git clone command for the project', async function () {
    renderCard(readAndWrite)
    await openModal()

    const command = screen.getByLabelText('Git clone project command')
    expect(command.textContent).to.equal(
      `git clone ${GIT_BRIDGE_BASE_URL}/${PROJECT_ID}`
    )
  })

  it('shows the MCP endpoint and the command to add it', async function () {
    renderCard(readAndWrite)
    await openModal()

    expect(screen.getByLabelText('MCP endpoint').textContent).to.equal(
      'https://www.dev-overleaf.com/mcp'
    )
    expect(
      screen.getByLabelText('Add MCP server command').textContent
    ).to.equal(
      'claude mcp add --transport http overleaf https://www.dev-overleaf.com/mcp --header "Authorization: Bearer <token>"'
    )
  })

  it('links to the account settings page in a new tab', async function () {
    renderCard(readAndWrite)
    await openModal()

    const link = screen.getByRole('link', { name: 'Go to settings' })
    expect(link.getAttribute('href')).to.equal('/user/settings')
    expect(link.getAttribute('target')).to.equal('_blank')
  })

  it('does not warn about access when the user can write', async function () {
    renderCard(readAndWrite)
    await openModal()

    expect(screen.queryByText(/You have read-only access/)).to.be.null
    expect(screen.queryByText(/You have review access/)).to.be.null
  })

  it('warns read-only users that they cannot push', async function () {
    renderCard(readOnly)
    await openModal()

    screen.getByText(/You have read-only access to this project./)
  })

  it('warns reviewers that they cannot push', async function () {
    renderCard(reviewOnly)
    await openModal()

    screen.getByText(/You have review access to this project./)
  })

  it('opens the history view with the labels-only filter preselected', async function () {
    const setView = sinon.stub()
    renderCard(readAndWrite, setView)
    await openModal()

    fireEvent.click(screen.getByRole('button', { name: 'View change history' }))

    expect(setView).to.have.been.calledWith('history')
    expect(
      localStorage.getItem(`history.userPrefs.showOnlyLabels.${PROJECT_ID}`)
    ).to.equal(true)
  })
})
