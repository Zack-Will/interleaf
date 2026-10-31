import { memo, useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import classNames from 'classnames'
import OLButton from '@/shared/components/ol/ol-button'
import { PreventSelectingEntry } from '@/features/review-panel/components/review-panel-prevent-selecting'
import { DiffPart, truncateParts, wordDiff } from '../word-diff'

// Characters shown on each side while the pair is folded
const FOLD_LIMIT = 160

type Side = 'removed' | 'added'

const SIGNS: Record<Side, string> = {
  removed: '−',
  added: '+',
}

function sidesOf(deleted?: string, inserted?: string) {
  if (deleted != null && inserted != null) {
    return wordDiff(deleted, inserted)
  }
  // a single side is all change: the block colour says so, no word highlight
  const whole = (text?: string) =>
    text == null ? null : [{ text, changed: false }]
  return { removed: whole(deleted), added: whole(inserted) }
}

const DiffBlock = memo<{
  side: Side
  parts: DiffPart[]
  truncated: boolean
  label: string
}>(function DiffBlock({ side, parts, truncated, label }) {
  const Highlight = side === 'removed' ? 'del' : 'ins'
  return (
    <div
      className={`suggestion-diff-block suggestion-diff-${side}`}
      aria-label={label}
    >
      <span className="suggestion-diff-sign" aria-hidden="true">
        {SIGNS[side]}
      </span>
      <span className="suggestion-diff-text">
        {parts.map((part, index) =>
          part.changed ? (
            <Highlight key={index} className="suggestion-diff-word">
              {part.text}
            </Highlight>
          ) : (
            part.text
          )
        )}
        {truncated && '…'}
      </span>
    </div>
  )
})

/**
 * A suggested change shown like a git diff: the old text in a red block and
 * the new text in a green block underneath, with the words that differ
 * highlighted. Long text is folded, both sides together.
 */
export const SuggestionDiff = memo<{
  deleted?: string
  inserted?: string
  foldLimit?: number
}>(function SuggestionDiff({ deleted, inserted, foldLimit = FOLD_LIMIT }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)

  const sides = useMemo(() => sidesOf(deleted, inserted), [deleted, inserted])
  const limit = expanded ? Infinity : foldLimit
  const removed = sides.removed && truncateParts(sides.removed, limit)
  const added = sides.added && truncateParts(sides.added, limit)
  const foldable =
    (deleted?.length ?? 0) > foldLimit || (inserted?.length ?? 0) > foldLimit

  const toggle = useCallback(() => {
    setExpanded(value => !value)
    // the entry changed height; let the review panel lay its entries out again
    ref.current?.dispatchEvent(
      new CustomEvent('review-panel:position', { bubbles: true })
    )
  }, [])

  return (
    <div
      ref={ref}
      className={classNames('suggestion-diff', {
        'suggestion-diff-expanded': expanded,
      })}
    >
      {removed && (
        <DiffBlock
          side="removed"
          parts={removed.parts}
          truncated={removed.truncated}
          label={t('tracked_change_deleted')}
        />
      )}
      {added && (
        <DiffBlock
          side="added"
          parts={added.parts}
          truncated={added.truncated}
          label={t('tracked_change_added')}
        />
      )}
      {foldable && (
        <PreventSelectingEntry>
          <OLButton variant="link" className="btn-inline-link" onClick={toggle}>
            {expanded ? t('show_less') : t('show_more')}
          </OLButton>
        </PreventSelectingEntry>
      )}
    </div>
  )
})
