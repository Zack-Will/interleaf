import { DropdownItem } from '@/shared/components/dropdown/dropdown-menu'
import { useLivePreviewContext } from './live-preview-provider'

export default function LivePreviewCompileDropdownItem() {
  const live = useLivePreviewContext()
  if (!live?.available) return null
  return (
    <li role="none">
      <DropdownItem
        as="button"
        trailingIcon={live.enabled ? 'check' : null}
        onClick={() => live.setEnabled(!live.enabled)}
      >
        Live preview
      </DropdownItem>
    </li>
  )
}
