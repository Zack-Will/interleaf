import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import Origin from '@/features/history/components/change-list/origin'
import { Meta } from '@/features/history/services/types/shared'

function renderOrigin(origin: Meta['origin']) {
  render(<Origin origin={origin} />)
  return screen.findByTestId('history-version-origin')
}

describe('<Origin />', function () {
  it('names the agent when the MCP client reported one', async function () {
    const suffix = await renderOrigin({ kind: 'mcp', agent: 'Claude Code' })

    expect(suffix.textContent).to.equal('(via Claude Code)')
  })

  it('falls back to the generic wording for an unnamed agent', async function () {
    const suffix = await renderOrigin({ kind: 'mcp' })

    expect(suffix.textContent).to.equal('(via Agent)')
  })

  it('renders the git-bridge origin as "(via Git)"', async function () {
    const suffix = await renderOrigin({ kind: 'git-bridge' })

    expect(suffix.textContent).to.equal('(via Git)')
  })

  it('renders the Dropbox origin unchanged', async function () {
    const suffix = await renderOrigin({ kind: 'dropbox' })

    expect(suffix.textContent).to.equal('(via Dropbox)')
  })

  it('renders the GitHub origin unchanged', async function () {
    const suffix = await renderOrigin({ kind: 'github' })

    expect(suffix.textContent).to.equal('(via GitHub)')
  })

  it('is a muted suffix on the author line, not a badge', async function () {
    const suffix = await renderOrigin({ kind: 'git-bridge' })

    expect(suffix.tagName).to.equal('SPAN')
    expect(suffix.className).to.equal('history-version-origin')
    expect(screen.queryByTestId('history-version-origin-badge')).to.be.null
  })

  it('renders nothing without an origin', function () {
    const { container } = render(<Origin origin={undefined} />)

    expect(container.innerHTML).to.equal('')
  })

  it('renders nothing for origins with their own change entry', function () {
    const { container } = render(
      <Origin origin={{ kind: 'project-restore', timestamp: 0, version: 1 }} />
    )

    expect(container.innerHTML).to.equal('')
  })
})
