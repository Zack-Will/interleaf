import { expect } from 'chai'
import {
  DiffPart,
  tokenize,
  truncateParts,
  wordDiff,
} from '../../../frontend/js/word-diff'

const join = (parts: DiffPart[]) => parts.map(part => part.text).join('')
const changed = (parts: DiffPart[]) =>
  parts.filter(part => part.changed).map(part => part.text)

describe('wordDiff', function () {
  it('should cut text into words, spaces, punctuation and CJK characters', function () {
    expect(tokenize('It sustains 2.51 GB/s.')).to.deep.equal([
      'It',
      ' ',
      'sustains',
      ' ',
      '2',
      '.',
      '51',
      ' ',
      'GB',
      '/',
      's',
      '.',
    ])
    expect(tokenize('内存分层 ok')).to.deep.equal([
      '内',
      '存',
      '分',
      '层',
      ' ',
      'ok',
    ])
  })

  it('should give back each side when its parts are joined', function () {
    const oldText = 'The system relocates pages between tiers.'
    const newText = 'The system migrates hot pages across tiers!'
    const { removed, added } = wordDiff(oldText, newText)
    expect(join(removed)).to.equal(oldText)
    expect(join(added)).to.equal(newText)
  })

  it('should mark only the words that differ', function () {
    const { removed, added } = wordDiff(
      'The system relocates pages.',
      'The system migrates pages.'
    )
    expect(changed(removed)).to.deep.equal(['relocates'])
    expect(changed(added)).to.deep.equal(['migrates'])
  })

  it('should highlight a changed phrase as one run including its spaces', function () {
    const { removed, added } = wordDiff(
      'We relocate cold data now.',
      'We migrate hot pages now.'
    )
    expect(changed(removed)).to.deep.equal(['relocate cold data'])
    expect(changed(added)).to.deep.equal(['migrate hot pages'])
  })

  it('should diff CJK text character by character', function () {
    const { removed, added } = wordDiff('内存分层。', '内存分层很有用。')
    expect(changed(removed)).to.deep.equal([])
    expect(changed(added)).to.deep.equal(['很有用'])
  })
})

describe('truncateParts', function () {
  const parts = [
    { text: 'abc', changed: false },
    { text: 'def', changed: true },
  ]

  it('should keep everything within the limit', function () {
    expect(truncateParts(parts, 6)).to.deep.equal({ parts, truncated: false })
  })

  it('should cut inside a part at the limit', function () {
    expect(truncateParts(parts, 4)).to.deep.equal({
      parts: [
        { text: 'abc', changed: false },
        { text: 'd', changed: true },
      ],
      truncated: true,
    })
  })
})
