import { expect } from 'chai'
import { render, screen } from '@testing-library/react'
import HistoryVersionMessage from '@/features/history/components/change-list/history-version-message'
import { Meta } from '@/features/history/services/types/shared'

function renderMessage(origin: Meta['origin']) {
  return render(<HistoryVersionMessage origin={origin} />)
}

describe('<HistoryVersionMessage />', function () {
  it('shows the message an agent sent with the write', async function () {
    renderMessage({
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Rewrite the abstract for clarity',
    })

    const subtitle = await screen.findByTestId('history-version-message')
    expect(subtitle.textContent).to.equal('Rewrite the abstract for clarity')
  })

  it('keeps the whole message in the tooltip so it can be truncated', async function () {
    const message = 'Answer the three comments on section 2 and tighten it'
    renderMessage({ kind: 'mcp', message })

    const subtitle = await screen.findByTestId('history-version-message')
    expect(subtitle.getAttribute('title')).to.equal(message)
    expect(subtitle.className).to.equal('history-version-message')
  })

  it('shows the message of a suggestion as well', async function () {
    renderMessage({
      kind: 'mcp',
      agent: 'Claude Code',
      message: 'Tighten the opening paragraph',
      suggestion: true,
    })

    const subtitle = await screen.findByTestId('history-version-message')
    expect(subtitle.textContent).to.equal('Tighten the opening paragraph')
  })

  it('renders nothing for an agent write with no message', function () {
    const { container } = renderMessage({ kind: 'mcp', agent: 'Claude Code' })

    expect(container.innerHTML).to.equal('')
  })

  it('renders nothing for other origins', function () {
    const { container } = renderMessage({ kind: 'git-bridge' })

    expect(container.innerHTML).to.equal('')
  })

  it('renders nothing without an origin', function () {
    const { container } = renderMessage(undefined)

    expect(container.innerHTML).to.equal('')
  })
})
