// The structured edits `edit_file` and `suggest_edits` share.  Pure functions
// only: they take the lines of a document and return new lines, so the tools,
// the unit tests and the smoke script can run them without any service.
import { z } from 'zod'
import {
  AnchorAmbiguousError,
  AnchorNotFoundError,
  InvalidEditError,
} from '../../../project-sync/app/src/Errors.mjs'

export const EDIT_TYPES = [
  'replace_range',
  'replace_anchor',
  'insert_at_anchor',
  'replace_section',
]

const SECTION_LEVELS = [
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
]

const INSERT_SIDES = ['before', 'after']

const NEW_TEXT =
  'The replacement text; lines are separated by \\n. An empty string deletes what the edit selects.'
const OCCURRENCE =
  'Which match of anchor to use, counted from 1 in document order. Required when the anchor occurs more than once.'
const ANCHOR =
  'Exact text currently in the document, copied from read_file without the line-number prefix; it may span lines.'

const replaceRangeSchema = z.object({
  type: z.literal('replace_range'),
  start_line: z
    .number()
    .int()
    .min(1)
    .describe('First line to replace, 1-based as read_file numbers them.'),
  end_line: z
    .number()
    .int()
    .optional()
    .describe(
      'Last line to replace, inclusive; defaults to start_line. Pass start_line - 1 to insert before start_line without replacing anything.'
    ),
  new_text: z.string().describe(NEW_TEXT),
})

const replaceAnchorSchema = z.object({
  type: z.literal('replace_anchor'),
  anchor: z.string().min(1).describe(ANCHOR),
  new_text: z.string().describe(NEW_TEXT),
  occurrence: z.number().int().min(1).optional().describe(OCCURRENCE),
})

const insertAtAnchorSchema = z.object({
  type: z.literal('insert_at_anchor'),
  anchor: z.string().min(1).describe(ANCHOR),
  side: z
    .enum(INSERT_SIDES)
    .describe('Insert immediately before or immediately after the anchor.'),
  new_text: z
    .string()
    .describe(
      'Text to insert, as is: include a leading or trailing \\n to insert whole lines.'
    ),
  occurrence: z.number().int().min(1).optional().describe(OCCURRENCE),
})

const replaceSectionSchema = z.object({
  type: z.literal('replace_section'),
  title: z
    .string()
    .describe('The heading title exactly as written inside the braces.'),
  level: z
    .enum(SECTION_LEVELS)
    .optional()
    .describe(
      'Heading level to match. Without it any level matches, and several headings with the same title are an error that lists them.'
    ),
  new_text: z
    .string()
    .describe(
      'The whole new section, starting with its heading line (for example \\section{Title}): the heading is replaced too. The section ends before the next heading of the same or a higher level, \\appendix, the bibliography or \\end{document}.'
    ),
})

/**
 * The schema the tools advertise: one variant per edit type, each listing only
 * its own fields.  Arguments are not validated against it by the MCP SDK (see
 * `editsSchema`); `validateEdits` applies the same rules with messages that
 * name the failing edit.
 */
export const editSchema = z.discriminatedUnion('type', [
  replaceRangeSchema,
  replaceAnchorSchema,
  insertAtAnchorSchema,
  replaceSectionSchema,
])

function advertisedEditJsonSchema() {
  const { $schema, ...schema } = z.toJSONSchema(editSchema, { io: 'input' })
  return schema
}

/**
 * The `edits` argument of `edit_file` and `suggest_edits`.  The MCP SDK
 * validates arguments before the tool runs and answers a failure with a bare
 * "Invalid input at edits.0.type", without an error code or a next step.  So
 * the runtime schema only asks for an array of objects, and `tools/list`
 * still shows the full discriminated union through the JSON Schema metadata.
 */
export const editsSchema = z
  .array(z.looseObject({}))
  .meta({ items: advertisedEditJsonSchema() })

export const EDIT_EXAMPLES = [
  '{"type":"replace_range","start_line":12,"end_line":14,"new_text":"new line 12\\nnew line 13"}',
  '{"type":"replace_anchor","anchor":"old sentence.","new_text":"new sentence."}',
  '{"type":"insert_at_anchor","anchor":"\\\\end{abstract}","side":"after","new_text":"\\n\\\\section{Introduction}\\nText."}',
  '{"type":"replace_section","title":"Results","level":"section","new_text":"\\\\section{Results}\\nNew body."}',
]

export const EDITS_DESCRIPTION = [
  'Edit types (all line numbers 1-based, as read_file shows them):',
  '- replace_range: replace lines start_line..end_line; end_line = start_line - 1 inserts before start_line.',
  '- replace_anchor: replace the exact text anchor; occurrence (1-based) picks one of several matches.',
  '- insert_at_anchor: insert new_text before or after anchor (side), nothing is removed.',
  '- replace_section: replace a whole section, heading included, found by title and optional level; the section stops before the next heading of the same or a higher level, \\appendix, the bibliography or \\end{document}.',
  'Delete with new_text: "". Edits apply in order, each to the result of the previous one, and all or none are applied.',
  'Examples:',
  ...EDIT_EXAMPLES,
].join('\n')

const REQUIRED_FIELDS = {
  replace_range: ['start_line', 'new_text'],
  replace_anchor: ['anchor', 'new_text'],
  insert_at_anchor: ['anchor', 'side', 'new_text'],
  replace_section: ['title', 'new_text'],
}

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

function lineOfOffset(text, offset) {
  return text.slice(0, offset).split('\n').length
}

function isBackMatter(line) {
  return BACK_MATTER.some(pattern => pattern.test(line))
}

function isBlankOrComment(line) {
  return /^\s*(?:%.*)?$/.test(line)
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1
}

function fieldProblem(edit, field) {
  const value = edit[field]
  if (value == null) return field
  if (field === 'start_line' || field === 'end_line')
    return Number.isInteger(value) ? null : `${field} (not an integer)`
  if (field === 'side')
    return INSERT_SIDES.includes(value) ? null : `side (not before or after)`
  if (typeof value !== 'string') return `${field} (not a string)`
  if (field === 'anchor' && value === '') return 'anchor (empty)'
  return null
}

/**
 * Check one edit's fields against its type before anything runs, so a missing
 * field is reported as such and not as whatever the edit would have tripped
 * over on the way.
 *
 * @param {object} edit
 */
function validateEdit(edit) {
  if (!edit || typeof edit !== 'object' || Array.isArray(edit))
    throw new InvalidEditError('an edit must be an object with a type')
  if (!EDIT_TYPES.includes(edit.type))
    throw new InvalidEditError(
      `unknown edit type ${JSON.stringify(edit.type ?? null)}; expected one of: ${EDIT_TYPES.join(', ')}`,
      { validValues: EDIT_TYPES }
    )
  const required = REQUIRED_FIELDS[edit.type]
  const optional = edit.type === 'replace_range' ? ['end_line'] : []
  const problems = [...required, ...optional]
    .filter(field => required.includes(field) || edit[field] != null)
    .map(field => fieldProblem(edit, field))
    .filter(Boolean)
  if (problems.length)
    throw new InvalidEditError(
      `${edit.type} requires ${required.join(' and ')}; missing or invalid: ${problems.join(', ')}`
    )
  if (edit.occurrence != null && !isPositiveInteger(edit.occurrence))
    throw new InvalidEditError(
      'occurrence counts matches from 1 and must be a positive integer'
    )
  if (
    edit.type === 'replace_section' &&
    edit.level != null &&
    !SECTION_LEVELS.includes(edit.level)
  )
    throw new InvalidEditError(
      `invalid section level ${JSON.stringify(edit.level)}; expected one of: ${SECTION_LEVELS.join(', ')}`,
      { validValues: SECTION_LEVELS }
    )
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

function headingPattern(title) {
  return new RegExp(
    '^\\s*\\\\(' +
      SECTION_LEVELS.join('|') +
      ')\\*?\\s*(?:\\[[^\\]]*\\])?\\s*\\{' +
      escapeRegExp(title) +
      '\\}'
  )
}

function describeMatches(matches) {
  return matches.map(match => `${match.level} at line ${match.line}`).join(', ')
}

function headingSummaries(matches) {
  return matches.map(match => ({ line: match.line, level: match.level }))
}

// The heading `title` names, at `level` when given and at any level
// otherwise.  More than one candidate is refused rather than guessed.
function findSection(lines, title, level) {
  const heading = headingPattern(title)
  const all = []
  lines.forEach((line, index) => {
    const found = line.match(heading)
    if (found) all.push({ index, line: index + 1, level: found[1] })
  })
  const matches = level ? all.filter(match => match.level === level) : all
  if (!matches.length) {
    const elsewhere = all.length
      ? `; found at another level: ${describeMatches(all)}`
      : ''
    const error = new AnchorNotFoundError(
      `no ${level || 'heading'} titled ${JSON.stringify(title)}${elsewhere}`,
      all.length ? { matches: headingSummaries(all) } : {}
    )
    error.next_action = all.length
      ? 'pass the level of the heading you mean, or omit level to match any level'
      : 'call get_outline to see the headings and their exact titles'
    throw error
  }
  if (matches.length > 1) {
    const error = new AnchorAmbiguousError(
      `${matches.length} headings are titled ${JSON.stringify(title)}: ${describeMatches(matches)}`,
      {
        matches: headingSummaries(matches),
        candidateLines: matches.map(match => match.line),
      }
    )
    error.next_action = level
      ? 'several headings share this title and level; use replace_range with the lines of the one you mean'
      : 'pass level to pick one of them'
    throw error
  }
  return { heading, match: matches[0] }
}

function replaceSection(lines, edit) {
  const { heading, match } = findSection(lines, edit.title, edit.level)
  const start = match.index
  const end = sectionEnd(lines, start, SECTION_LEVELS.indexOf(match.level))
  const replacementLines = splitLines(edit.new_text)
  if (!heading.test(replacementLines[0] || '')) {
    const error = new InvalidEditError(
      `replace_section replaces the heading too, so new_text must start with the heading line, for example \\${match.level}{${edit.title}}`
    )
    error.next_action =
      'put the heading line first in new_text, or use replace_range on the body lines to keep the heading'
    throw error
  }
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

function replaceRange(lines, edit) {
  const start = edit.start_line
  const end = edit.end_line ?? start
  if (start < 1 || end > lines.length || end < start - 1)
    throw new InvalidEditError(
      `line range ${start}-${end} is outside a document of ${lines.length} lines (end_line = start_line - 1 inserts)`
    )
  const inserting = end < start
  const replacement = splitLines(edit.new_text).join('\n')
  const change = {
    start: offsetOfLineIndex(lines, start - 1),
    oldLength: inserting ? 0 : lines.slice(start - 1, end).join('\n').length,
    newText: inserting ? `${replacement}\n` : replacement,
    reanchor: false,
  }
  const report = inserting
    ? { type: 'replace_range', inserted_at_line: start }
    : { type: 'replace_range', replaced_lines: [start, end] }
  lines.splice(
    start - 1,
    Math.max(0, end - start + 1),
    ...splitLines(edit.new_text)
  )
  return { change, report }
}

// The position of the anchor the edit names: its only match, or the one
// `occurrence` (1-based) picks.
function locateAnchor(text, edit) {
  const anchor = edit.anchor
  const positions = []
  let at = text.indexOf(anchor)
  while (at >= 0) {
    positions.push(at)
    at = text.indexOf(anchor, at + 1)
  }
  if (!positions.length) throw new AnchorNotFoundError()
  const candidateLines = positions.map(position => lineOfOffset(text, position))
  if (edit.occurrence != null) {
    if (edit.occurrence > positions.length) {
      const error = new AnchorNotFoundError(
        `anchor occurs ${positions.length} time${positions.length === 1 ? '' : 's'}, so there is no occurrence ${edit.occurrence}`,
        { candidateLines }
      )
      error.next_action = `pass an occurrence between 1 and ${positions.length} (candidate_lines lists them in order)`
      throw error
    }
    return positions[edit.occurrence - 1]
  }
  if (positions.length > 1) {
    const error = new AnchorAmbiguousError(
      `anchor is ambiguous: it occurs ${positions.length} times`,
      { candidateLines }
    )
    error.next_action = `pass occurrence (1 to ${positions.length}, in the order of candidate_lines) or a longer anchor`
    throw error
  }
  return positions[0]
}

function replaceAnchor(lines, edit) {
  const text = lines.join('\n')
  const position = locateAnchor(text, edit)
  const firstLine = lineOfOffset(text, position)
  const change = {
    start: position,
    oldLength: edit.anchor.length,
    newText: edit.new_text,
    reanchor: true,
  }
  const report = {
    type: 'replace_anchor',
    replaced_lines: [firstLine, firstLine + edit.anchor.split('\n').length - 1],
  }
  const replacement =
    text.slice(0, position) +
    edit.new_text +
    text.slice(position + edit.anchor.length)
  return { change, report, lines: splitLines(replacement) }
}

function insertAtAnchor(lines, edit) {
  const text = lines.join('\n')
  const anchorAt = locateAnchor(text, edit)
  const position =
    edit.side === 'after' ? anchorAt + edit.anchor.length : anchorAt
  const change = {
    start: position,
    oldLength: 0,
    newText: edit.new_text,
    reanchor: false,
  }
  const report = {
    type: 'insert_at_anchor',
    inserted_at_line: lineOfOffset(text, position),
  }
  const inserted =
    text.slice(0, position) + edit.new_text + text.slice(position)
  return { change, report, lines: splitLines(inserted) }
}

function applyEdit(lines, edit) {
  if (edit.type === 'replace_range') return replaceRange(lines, edit)
  if (edit.type === 'replace_anchor') return replaceAnchor(lines, edit)
  if (edit.type === 'insert_at_anchor') return insertAtAnchor(lines, edit)
  return replaceSection(lines, edit)
}

// Every failure names the edit it came from, so a batch of several edits can
// be fixed without guessing which one broke.
function atEdit(index, run) {
  try {
    return run()
  } catch (error) {
    error.message = `edits[${index}]: ${error.message}`
    error.editIndex = index
    throw error
  }
}

/**
 * Apply the structured edits of `edit_file` to a document, in order, and
 * report each replacement as a character range of the document as it stood
 * when that edit ran.  `suggest_edits` builds its new content the same way,
 * so the two tools take identical `edits` and behave identically on an
 * ambiguous or missing anchor.
 *
 * Every edit is validated before the first one runs.  `reports` has one entry
 * per edit, with the lines it replaced counted in the document as it stood
 * when that edit ran; `warnings` collects the warnings of every report.
 *
 * @param {string[]} documentLines
 * @param {Array<object>} edits
 * @return {{lines: string[], changes: Array<object>, reports: Array<object>,
 *           warnings: string[]}}
 */
export function applyStructuredEdits(documentLines, edits) {
  edits.forEach((edit, index) => atEdit(index, () => validateEdit(edit)))
  let lines = [...documentLines]
  const changes = []
  const reports = []
  edits.forEach((edit, index) => {
    const result = atEdit(index, () => applyEdit(lines, edit))
    if (result.lines) lines = result.lines
    changes.push(result.change)
    reports.push(result.report)
  })
  const warnings = reports
    .map((report, index) =>
      report.warning ? `edits[${index}]: ${report.warning}` : null
    )
    .filter(Boolean)
  return { lines, changes, reports, warnings }
}
