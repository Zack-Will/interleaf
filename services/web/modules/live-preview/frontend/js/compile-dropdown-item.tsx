import { DropdownItem } from '@/shared/components/dropdown/dropdown-menu'
import { useLivePreviewContext } from './live-preview-provider'
import { useTranslation } from 'react-i18next'

export default function LivePreviewCompileDropdownItem() {
  const live = useLivePreviewContext()
  const { t } = useTranslation()
  if (!live?.available) return null
  return (
    <li role="none">
      <DropdownItem
        as="button"
        trailingIcon={live.enabled ? 'check' : null}
        onClick={() => live.setEnabled(!live.enabled)}
      >
        {t('live_preview')}
      </DropdownItem>
    </li>
  )
}
