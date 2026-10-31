import { expect } from 'chai'
import {
  findSuggestionAt,
  renderOriginal,
} from '../../../frontend/js/suggestion-hover'
import { Change, EditOperation } from '../../../../../types/change'
import { UserId } from '../../../../../types/user'

const metadata = { user_id: 'agent' as UserId, ts: new Date() }

function insertion(id: string, p: number, i: string): Change<EditOperation> {
  return { id, op: { p, i }, metadata }
}

function deletion(id: string, p: number, d: string): Change<EditOperation> {
  return { id, op: { p, d }, metadata }
}

describe('suggestion hover', function () {
  const changes = [
    insertion('ins-1', 10, 'migrates hot pages.'),
    deletion('del-1', 29, 'relocates pages.'),
    insertion('ins-2', 50, 'Plain insert.'),
    insertion('ins-3', 80, 'Other user.'),
    {
      ...deletion('del-3', 91, 'Old.'),
      metadata: { user_id: 'someone' as UserId, ts: new Date() },
    },
  ] as Change<EditOperation>[]

  it('should find the suggestion whose inserted text is under the pointer', function () {
    const suggestion = findSuggestionAt(changes, 15)
    expect(suggestion?.insertion.id).to.equal('ins-1')
    expect(suggestion?.deletion.id).to.equal('del-1')
  })

  it('should find a deletion placed right before the insertion', function () {
    const suggestion = findSuggestionAt(
      [deletion('del-0', 5, 'Was.'), insertion('ins-0', 5, 'Is.')],
      6
    )
    expect(suggestion?.deletion.id).to.equal('del-0')
  })

  it('should ignore an insertion that did not replace anything', function () {
    expect(findSuggestionAt(changes, 55)).to.equal(null)
  })

  it('should ignore a deletion by another user', function () {
    expect(findSuggestionAt(changes, 85)).to.equal(null)
  })

  it('should ignore positions outside any insertion', function () {
    expect(findSuggestionAt(changes, 2)).to.equal(null)
  })

  it('should render the original text with the replaced words highlighted', function () {
    const suggestion = findSuggestionAt(changes, 15)
    const dom = renderOriginal(suggestion!)
    expect(
      dom.querySelector('.suggestion-diff-removed .suggestion-diff-text')
        ?.textContent
    ).to.equal('relocates pages.')
    expect(
      [...dom.querySelectorAll('del.suggestion-diff-word')].map(
        element => element.textContent
      )
    ).to.deep.equal(['relocates'])
    expect(dom.querySelector('.suggestion-diff-added')).to.equal(null)
  })
})
