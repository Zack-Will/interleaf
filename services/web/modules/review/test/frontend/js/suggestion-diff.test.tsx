import { expect } from 'chai'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SuggestionDiff } from '../../../frontend/js/components/suggestion-diff'

describe('<SuggestionDiff />', function () {
  afterEach(function () {
    cleanup()
  })

  it('should show the old text in a removed block above the new text in an added block', function () {
    const { container } = render(
      <SuggestionDiff
        deleted="The system relocates pages."
        inserted="The system migrates pages."
      />
    )
    const blocks = container.querySelectorAll('.suggestion-diff-block')
    expect(blocks).to.have.length(2)
    expect(blocks[0].classList.contains('suggestion-diff-removed')).to.equal(
      true
    )
    expect(
      blocks[0].querySelector('.suggestion-diff-sign')?.textContent
    ).to.equal('−')
    expect(
      blocks[0].querySelector('.suggestion-diff-text')?.textContent
    ).to.equal('The system relocates pages.')
    expect(blocks[1].classList.contains('suggestion-diff-added')).to.equal(true)
    expect(
      blocks[1].querySelector('.suggestion-diff-text')?.textContent
    ).to.equal('The system migrates pages.')
  })

  it('should highlight the changed words on each side', function () {
    const { container } = render(
      <SuggestionDiff
        deleted="The system relocates pages."
        inserted="The system migrates pages."
      />
    )
    expect(
      [...container.querySelectorAll('del.suggestion-diff-word')].map(
        element => element.textContent
      )
    ).to.deep.equal(['relocates'])
    expect(
      [...container.querySelectorAll('ins.suggestion-diff-word')].map(
        element => element.textContent
      )
    ).to.deep.equal(['migrates'])
  })

  it('should render a plain insertion as a single block without word highlights', function () {
    const { container } = render(<SuggestionDiff inserted="A new sentence." />)
    expect(container.querySelectorAll('.suggestion-diff-block')).to.have.length(
      1
    )
    expect(container.querySelector('.suggestion-diff-added')).to.exist
    expect(container.querySelector('.suggestion-diff-word')).not.to.exist
  })

  it('should fold both sides together behind one show more link', function () {
    const deleted = 'Old sentence. '.repeat(20)
    const inserted = 'New sentence. '.repeat(20)
    const { container } = render(
      <SuggestionDiff deleted={deleted} inserted={inserted} foldLimit={30} />
    )
    const texts = () =>
      [...container.querySelectorAll('.suggestion-diff-text')].map(
        element => element.textContent
      )
    expect(texts()).to.deep.equal([
      `${deleted.slice(0, 30)}…`,
      `${inserted.slice(0, 30)}…`,
    ])
    expect(screen.getAllByRole('button')).to.have.length(1)

    fireEvent.click(screen.getByRole('button', { name: 'show more' }))
    expect(texts()).to.deep.equal([deleted, inserted])

    fireEvent.click(screen.getByRole('button', { name: 'show less' }))
    expect(texts()[0]).to.equal(`${deleted.slice(0, 30)}…`)
  })

  it('should not offer folding for short text', function () {
    render(<SuggestionDiff deleted="Short." inserted="Brief." />)
    expect(screen.queryByRole('button')).to.equal(null)
  })
})
