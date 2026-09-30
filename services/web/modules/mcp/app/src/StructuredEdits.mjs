// The structured edits `edit_file` and `suggest_edits` share.  Pure functions
// only: they take the lines of a document and return new lines, so the tools,
// the unit tests and the smoke script can run them without any service.
import { z } from 'zod'
import {
  AnchorAmbiguousError,
  AnchorNotFoundError,
  InvalidEditError,
} from '../../../project-sync/app/src/Errors.mjs'

export const editSchema = z.object({
  type: z.string(),
  start_line: z.number().optional(),
  end_line: z.number().optional(),
  new_text: z.string().optional(),
  anchor: z.string().optional(),
  occurrence: z.number().optional(),
  title: z.string().optional(),
  level: z.string().optional(),
})

const SECTION_LEVELS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
]

const ANY_HEADING = new RegExp(
  '^\\s*\\\\(' + SECTION_LEVELS.join('|') + ')\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{'
)

// Lines that end the body of the last section even though they are not
// headings: the back matter of a paper.  Replacing the last section must never
// take the bibliography, the appendix or `\end{document}` with it.
const BACK_MATTER = [
  /^\s*\\appendix\b/,
  /^\s*\\bibliographystyle\b/,
  /^\s*\\bibliography\b/,
  /^\s*\\printbibliography\b/,
  /^\s*\\begin\{thebibliography\}/,
  /^\s*\\end\{document\}/,
  // `\input{appendix}` without a preceding `\appendix`: the appendix file
  // usually starts with the command itself.
  /^\s*\\(?:input|include)\{[^}]*appendix[^}]*\}/i,
]

// A replacement that removes this many more lines than it adds, and at least
// twice as many, is reported with a warning: replace_section works out the
// extent of the section itself, so the caller may not have expected it.
const SHRINK_WARNING_MIN_LINES = 5
const SHRINK_WARNING_RATIO = 2

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function offsetOfLineIndex(lines, index) {
  let offset = 0
  for (
    let position = 0;
    position < index && position < lines.length;
    position++
  )
    offset += lines[position].length + 1
  return offset
}

function splitLines(text) {
  return String(text ?? '').split(/\r\n|\n|\r/)
}

function isBackMatter(line) {
  return BACK_MATTER.some(pattern => pattern.test(line))
}

function isBlankOrComment(line) {
  return /^\s*(?:%.*)?$/.test(line)
}

/**
 * The index one past the last line of the section whose heading is at
 * `start`: the next heading of the same or a higher level, the back matter
 * of the document, or the end of the file, whichever comes first.  Blank and
 * comment-only lines just before that boundary belong to what follows (a
 * banner comment above the bibliography, say), so they are left in place.
 *
 * @param {string[]} lines
 * @param {number} start
 * @param {number} levelIndex
 * @return {number}
 */
export function sectionEnd(lines, start, levelIndex) {
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    const heading = lines[index].match(ANY_HEADING)
    if (heading && SECTION_LEVELS.indexOf(heading[1]) <= levelIndex) {
      end = index
      break
    }
    if (isBackMatter(lines[index])) {
      end = index
      break
    }
  }
  while (end > start + 1 && isBlankOrComment(lines[end - 1])) end -= 1
  return end
}

function shrinkWarning(removed, added) {
  if (
    removed - added < SHRINK_WARNING_MIN_LINES ||
    removed < SHRINK_WARNING_RATIO * added
  )
    return null
  return `replaced ${removed} lines with ${added}; check the diff to make sure nothing after the section was lost`
}

function replaceSection(lines, edit, split) {
  const level = edit.level || 'section'
  const levelIndex = SECTION_LEVELS.indexOf(level)
  if (levelIndex < 0) throw new InvalidEditError('invalid section level')
  const heading = new RegExp(
    '^\\s*\\\\(' +
      SECTION_LEVELS.join('|') +
      ')\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{' +
      escapeRegExp(edit.title) +
      '\\}'
  )
  const start = lines.findIndex(line => line.match(heading)?.[1] === level)
  if (start < 0) throw new AnchorNotFoundError('section not found')
  const end = sectionEnd(lines, start, levelIndex)
  const replacementLines = split(edit.new_text)
  if (!heading.test(replacementLines[0] || ''))
    throw new InvalidEditError('replace_section new_text must include heading')
  const removed = end - start
  const added = replacementLines.length
  const change = {
    start: offsetOfLineIndex(lines, start),
    oldLength: lines.slice(start, end).join('\n').length,
    newText: replacementLines.join('\n'),
    reanchor: true,
  }
  const warning = shrinkWarning(removed, added)
  const report = {
    type: 'replace_section',
    replaced_lines: [start + 1, end],
    lines_removed: removed,
    lines_added: added,
    ...(warning ? { warning } : {}),
  }
  lines.splice(start, removed, ...replacementLines)
  return { change, report }
}

/**
 * Apply the structured edits of `edit_file` to a document, in order, and
 * report each replacement as a character range of the document as it stood
 * when that edit ran.  `suggest_edits` builds its new content the same way,
 * so the two tools take identical `edits` and behave identically on an
 * ambiguous or missing anchor.
 *
 * `reports` has one entry per edit, with the lines it replaced counted in the
 * document as it stood when that edit ran; `warnings` collects the warnings
 * of every report.
 *
 * @param {string[]} documentLines
 * @param {Array<object>} edits
 * @return {{lines: string[], changes: Array<object>, reports: Array<object>,
 *           warnings: string[]}}
 */
export function applyStructuredEdits(documentLines, edits) {
  let lines = [...documentLines]
  const split = splitLines
  const changes = []
  const reports = []
  for (const edit of edits) {
    if (edit.type === 'replace_range') {
      const start = edit.start_line
      const end = edit.end_line ?? start
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 1 ||
        end > lines.length ||
        end < start - 1
      )
        throw new InvalidEditError('invalid line range')
      const inserting = end < start
      const replacement = split(edit.new_text).join('\n')
      changes.push({
        start: offsetOfLineIndex(lines, start - 1),
        oldLength: inserting
          ? 0
          : lines.slice(start - 1, end).join('\n').length,
        newText: inserting ? `${replacement}\n` : replacement,
        reanchor: false,
      })
      reports.push({ type: 'replace_range', replaced_lines: [start, end] })
      lines.splice(
        start - 1,
        Math.max(0, end - start + 1),
        ...split(edit.new_text)
      )
    } else if (edit.type === 'replace_anchor') {
      const anchor = String(edit.anchor ?? '')
      const text = lines.join('\n')
      const positions = []
      let at = text.indexOf(anchor)
      while (at >= 0) {
        positions.push(at)
        at = text.indexOf(anchor, at + 1)
      }
      if (!positions.length) throw new AnchorNotFoundError()
      const candidateLines = positions.map(
        position => text.slice(0, position).split('\n').length
      )
      if (edit.occurrence != null) {
        const selected = edit.occurrence - 1
        if (selected < 0 || selected >= positions.length)
          throw new AnchorNotFoundError()
        positions.splice(0, positions.length, positions[selected])
      } else if (positions.length > 1) {
        throw new AnchorAmbiguousError('anchor is ambiguous', {
          candidateLines,
        })
      }
      changes.push({
        start: positions[0],
        oldLength: anchor.length,
        newText: String(edit.new_text ?? ''),
        reanchor: true,
      })
      const firstLine = text.slice(0, positions[0]).split('\n').length
      const lastLine = firstLine + anchor.split('\n').length - 1
      reports.push({
        type: 'replace_anchor',
        replaced_lines: [firstLine, lastLine],
      })
      const replacement =
        text.slice(0, positions[0]) +
        String(edit.new_text ?? '') +
        text.slice(positions[0] + anchor.length)
      lines = split(replacement)
    } else if (edit.type === 'replace_section') {
      const { change, report } = replaceSection(lines, edit, split)
      changes.push(change)
      reports.push(report)
    } else throw new InvalidEditError(`unknown edit type ${edit.type}`)
  }
  const warnings = reports
    .map((report, index) =>
      report.warning ? `edits[${index}]: ${report.warning}` : null
    )
    .filter(Boolean)
  return { lines, changes, reports, warnings }
}
