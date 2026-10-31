import { EditorView, hoverTooltip, Tooltip } from '@codemirror/view'
import i18n from 'i18next'
import { rangesDataField } from '@/features/source-editor/extensions/ranges'
import {
  Change,
  DeleteOperation,
  EditOperation,
  InsertOperation,
} from '../../../../types/change'
import { DiffPart, wordDiff } from './word-diff'

type Suggestion = {
  insertion: Change<InsertOperation>
  deletion: Change<DeleteOperation>
}

function isInsertion(
  change: Change<EditOperation>
): change is Change<InsertOperation> {
  return 'i' in change.op
}

function isDeletion(
  change: Change<EditOperation>
): change is Change<DeleteOperation> {
  return 'd' in change.op
}

/**
 * Whether a tracked delete sits right before or right after a tracked insert
 * of the same user: the pair the review panel shows as one "changed" entry.
 */
function isPairedDeletion(
  deletion: Change<DeleteOperation>,
  insertion: Change<InsertOperation>
) {
  const userId = insertion.metadata?.user_id
  if (userId == null || deletion.metadata?.user_id !== userId) {
    return false
  }
  if (!/\S/.test(deletion.op.d)) {
    return false
  }
  const start = insertion.op.p
  const end = insertion.op.p + insertion.op.i.length
  return deletion.op.p === end || deletion.op.p === start
}

/**
 * The suggestion whose inserted text covers `pos`, if it replaced some text.
 */
export function findSuggestionAt(
  changes: Change<EditOperation>[],
  pos: number
): Suggestion | null {
  const insertion = changes
    .filter(isInsertion)
    .find(
      change => change.op.p <= pos && pos <= change.op.p + change.op.i.length
    )
  if (insertion == null) {
    return null
  }
  const deletion = changes
    .filter(isDeletion)
    .find(change => isPairedDeletion(change, insertion))
  if (deletion == null) {
    return null
  }
  return { insertion, deletion }
}

function renderParts(parts: DiffPart[]) {
  const text = document.createElement('span')
  text.className = 'suggestion-diff-text'
  for (const part of parts) {
    if (part.changed) {
      const word = document.createElement('del')
      word.className = 'suggestion-diff-word'
      word.textContent = part.text
      text.append(word)
    } else {
      text.append(part.text)
    }
  }
  return text
}

/**
 * The original text of a suggestion, coloured like the review panel's diff
 * card: the words the suggestion changes are highlighted.
 */
export function renderOriginal({ insertion, deletion }: Suggestion) {
  const dom = document.createElement('div')
  dom.className = 'suggestion-diff suggestion-diff-tooltip'

  const label = document.createElement('div')
  label.className = 'suggestion-diff-label'
  label.textContent = i18n.t('tracked_change_deleted')
  dom.append(label)

  const block = document.createElement('div')
  block.className = 'suggestion-diff-block suggestion-diff-removed'
  const sign = document.createElement('span')
  sign.className = 'suggestion-diff-sign'
  sign.setAttribute('aria-hidden', 'true')
  sign.textContent = '−'
  block.append(sign)
  const { removed } = wordDiff(deletion.op.d, insertion.op.i)
  block.append(renderParts(removed))
  dom.append(block)

  return dom
}

function suggestionTooltip(view: EditorView, pos: number): Tooltip | null {
  const changes = view.state.field(rangesDataField, false)?.ranges?.changes
  if (changes == null) {
    return null
  }
  const suggestion = findSuggestionAt(changes, pos)
  if (suggestion == null) {
    return null
  }
  const { insertion } = suggestion
  return {
    pos: insertion.op.p,
    end: insertion.op.p + insertion.op.i.length,
    above: true,
    create: () => ({ dom: renderOriginal(suggestion) }),
  }
}

/**
 * Hovering text a suggestion inserted shows the text it replaces. The
 * replaced text itself stays out of the editor, as a deletion marker.
 */
export function extension() {
  return hoverTooltip(suggestionTooltip, { hoverTime: 300 })
}
