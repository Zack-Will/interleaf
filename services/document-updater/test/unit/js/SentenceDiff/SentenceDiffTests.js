const { expect } = require('chai')
const SandboxedModule = require('sandboxed-module')
const modulePath = '../../../../app/js/SentenceDiff.js'

/**
 * Apply ShareJS text ops the way ShareJS does: each op against the text the
 * previous ones left.
 */
function applyOps(text, ops) {
  for (const op of ops) {
    if (op.d != null) {
      expect(text.slice(op.p, op.p + op.d.length)).to.equal(op.d)
      text = text.slice(0, op.p) + text.slice(op.p + op.d.length)
    } else {
      text = text.slice(0, op.p) + op.i + text.slice(op.p)
    }
  }
  return text
}

describe('SentenceDiff', function () {
  beforeEach(function () {
    this.SentenceDiff = SandboxedModule.require(modulePath)
    this.sentences = text =>
      this.SentenceDiff.splitSegments(text)
        .filter(segment => segment.sentence)
        .map(segment => segment.text)
    this.diff = (before, after) =>
      this.SentenceDiff.diffAsShareJsOp(before.split('\n'), after.split('\n'))
  })

  describe('splitSegments', function () {
    it('should cover the text exactly', function () {
      const text =
        '  Leading space. Two  spaces!\nNext line?\n\n\\section{A}\n% note\nEnd'
      const joined = this.SentenceDiff.splitSegments(text)
        .map(segment => segment.text)
        .join('')
      expect(joined).to.equal(text)
    })

    it('should split after . ? and ! followed by whitespace or the end', function () {
      expect(this.sentences('One. Two? Three! Four.')).to.deep.equal([
        'One.',
        'Two?',
        'Three!',
        'Four.',
      ])
    })

    it('should keep whitespace between sentences out of the sentences', function () {
      const segments = this.SentenceDiff.splitSegments('One.  Two.\nThree.')
      expect(segments).to.deep.equal([
        { text: 'One.', sentence: true },
        { text: '  ', sentence: false },
        { text: 'Two.', sentence: true },
        { text: '\n', sentence: false },
        { text: 'Three.', sentence: true },
      ])
    })

    it('should not split after common abbreviations', function () {
      expect(
        this.sentences(
          'We use e.g. caches, i.e. buffers. Smith et al. agree, etc. but see Fig. 2 and Eq. 3 in Sec. 4 vs. Ref. cf. No. 5 too. Done.'
        )
      ).to.deep.equal([
        'We use e.g. caches, i.e. buffers.',
        'Smith et al. agree, etc. but see Fig. 2 and Eq. 3 in Sec. 4 vs. Ref.',
        'cf. No. 5 too.',
        'Done.',
      ])
    })

    it('should match abbreviations case-insensitively and after a bracket', function () {
      expect(
        this.sentences('See (fig. 3) and (E.g. this). Next.')
      ).to.deep.equal(['See (fig. 3) and (E.g. this).', 'Next.'])
    })

    it('should not take a word ending in an abbreviation for it', function () {
      expect(this.sentences('Edit the config. Then run.')).to.deep.equal([
        'Edit the config.',
        'Then run.',
      ])
    })

    it('should not split inside a decimal number', function () {
      expect(this.sentences('It reached 2.51 GB/s. Then 3.0.')).to.deep.equal([
        'It reached 2.51 GB/s.',
        'Then 3.0.',
      ])
    })

    it('should not split at an escaped punctuation command', function () {
      expect(
        this.sentences(
          'A thin\\, space. The \\. accent and \\! stay. Mr.\\ Smith ok.'
        )
      ).to.deep.equal([
        'A thin\\, space.',
        'The \\. accent and \\! stay.',
        'Mr.\\ Smith ok.',
      ])
    })

    it('should keep closing brackets and quotes with the sentence', function () {
      expect(
        this.sentences("He said ``stop.'' (This is it.) Next.")
      ).to.deep.equal(["He said ``stop.''", '(This is it.)', 'Next.'])
    })

    it('should split after CJK terminators without whitespace', function () {
      expect(this.sentences('第一句。第二句！第三句？最后')).to.deep.equal([
        '第一句。',
        '第二句！',
        '第三句？',
        '最后',
      ])
    })

    it('should treat blank lines as a hard boundary', function () {
      expect(this.sentences('no period here\n\nnext paragraph')).to.deep.equal([
        'no period here',
        'next paragraph',
      ])
    })

    it('should keep a sentence that spans lines together', function () {
      expect(this.sentences('This sentence\nwraps. Next.')).to.deep.equal([
        'This sentence\nwraps.',
        'Next.',
      ])
    })

    it('should make LaTeX structure lines segments of their own', function () {
      expect(
        this.sentences(
          'Before\n\\section{Intro. More}\nprose\n\\begin{itemize}\n  \\item One. Two.\n\\end{itemize}\n% a comment. Still one\n\\subsection*{B}\nafter'
        )
      ).to.deep.equal([
        'Before',
        '\\section{Intro. More}',
        'prose',
        '\\begin{itemize}',
        '\\item One.',
        'Two.',
        '\\end{itemize}',
        '% a comment. Still one',
        '\\subsection*{B}',
        'after',
      ])
    })
  })

  describe('diffAsShareJsOp', function () {
    it('should return no ops for identical text', function () {
      expect(this.diff('One. Two.', 'One. Two.')).to.deep.equal([])
    })

    it('should replace a changed sentence with one delete and one insert', function () {
      const before = 'The system relocates pages. It sustains bandwidth.'
      const after = 'The system migrates hot pages. It sustains bandwidth.'
      const ops = this.diff(before, after)
      expect(ops).to.deep.equal([
        { d: 'The system relocates pages.', p: 0 },
        { i: 'The system migrates hot pages.', p: 0 },
      ])
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should pair each changed sentence separately', function () {
      const before = 'Alpha one. Beta two. Gamma three.'
      const after = 'Alpha uno. Beta two. Gamma tres.'
      const ops = this.diff(before, after)
      expect(ops).to.deep.equal([
        { d: 'Alpha one.', p: 0 },
        { i: 'Alpha uno.', p: 0 },
        { d: 'Gamma three.', p: 21 },
        { i: 'Gamma tres.', p: 21 },
      ])
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should make one hunk of adjacent changed sentences', function () {
      const before = 'Keep. Old one. Old two. Keep too.'
      const after = 'Keep. New merged sentence. Keep too.'
      const ops = this.diff(before, after)
      expect(ops).to.deep.equal([
        { d: 'Old one. Old two.', p: 6 },
        { i: 'New merged sentence.', p: 6 },
      ])
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should insert a new sentence as a single op', function () {
      const before = 'One. Three.'
      const after = 'One. Two. Three.'
      const ops = this.diff(before, after)
      expect(ops).to.have.length(1)
      expect(ops[0]).to.have.property('i')
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should delete a sentence as a single op', function () {
      const before = 'One. Two. Three.'
      const after = 'One. Three.'
      const ops = this.diff(before, after)
      expect(ops).to.have.length(1)
      expect(ops[0]).to.have.property('d')
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should leave unchanged whitespace and lines around a hunk alone', function () {
      const before = 'Intro.\n\nFirst point here.\nSecond point.\n'
      const after = 'Intro.\n\nFirst point, revised.\nSecond point.\n'
      const ops = this.diff(before, after)
      expect(ops).to.deep.equal([
        { d: 'First point here.', p: 8 },
        { i: 'First point, revised.', p: 8 },
      ])
    })

    it('should make a changed structure line its own hunk', function () {
      const before = '\\section{Old}\nBody text.'
      const after = '\\section{New}\nBody text.'
      expect(this.diff(before, after)).to.deep.equal([
        { d: '\\section{Old}', p: 0 },
        { i: '\\section{New}', p: 0 },
      ])
    })

    it('should handle CJK sentences', function () {
      const before = '第一句。第二句。第三句。'
      const after = '第一句。改写的第二句。第三句。'
      const ops = this.diff(before, after)
      expect(ops).to.deep.equal([
        { d: '第二句。', p: 4 },
        { i: '改写的第二句。', p: 4 },
      ])
      expect(applyOps(before, ops)).to.equal(after)
    })

    it('should handle text added to or removed from an empty document', function () {
      expect(applyOps('', this.diff('', 'New. Text.'))).to.equal('New. Text.')
      expect(applyOps('Old. Text.', this.diff('Old. Text.', ''))).to.equal('')
    })

    it('should round-trip a rewritten LaTeX document exactly', function () {
      const before = [
        '\\section{Introduction}',
        '% TODO: tighten',
        'Memory tiering relocates pages between DRAM and CXL. It sustains',
        'bandwidth of 2.51 GB/s, e.g. under load. Smith et al. report similar',
        'numbers (Fig. 3).',
        '',
        '\\begin{itemize}',
        '  \\item First. Second.',
        '\\end{itemize}',
        '内存分层。它很快！',
      ].join('\n')
      const after = [
        '\\section{Introduction and Motivation}',
        '% TODO: tighten',
        'Memory tiering migrates hot pages between DRAM and CXL. It sustains',
        'bandwidth of 2.51 GB/s, e.g. under load. Smith et al. report similar',
        'numbers (Fig. 3). We confirm this.',
        '',
        '\\begin{itemize}',
        '  \\item First.',
        '\\end{itemize}',
        '内存分层很有用。它很快！',
        '',
      ].join('\n')
      const ops = this.diff(before, after)
      expect(applyOps(before, ops)).to.equal(after)
      const inserted = ops.filter(op => op.i != null).map(op => op.i)
      expect(inserted).to.include(
        'Memory tiering migrates hot pages between DRAM and CXL.'
      )
      expect(inserted).to.include('\\section{Introduction and Motivation}')
      expect(inserted).to.include('内存分层很有用。')
    })

    it('should round-trip random sentence edits exactly', function () {
      const words = ['alpha', 'beta', 'gamma', 'delta', 'e.g.', '2.5', '。']
      const enders = ['. ', '? ', '\n', '\n\n', '! ', '。']
      let seed = 7
      const random = n => {
        seed = (seed * 1103515245 + 12345) % 2147483648
        return seed % n
      }
      const randomText = () => {
        let text = ''
        const length = random(30)
        for (let i = 0; i < length; i++) {
          text += words[random(words.length)]
          text += random(3) === 0 ? enders[random(enders.length)] : ' '
        }
        return text
      }
      for (let i = 0; i < 200; i++) {
        const before = randomText()
        const after = randomText()
        expect(applyOps(before, this.diff(before, after))).to.equal(after)
      }
    })
  })
})
