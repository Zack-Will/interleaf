import {
  DropdownDivider,
  DropdownHeader,
  DropdownItem,
} from '@/shared/components/dropdown/dropdown-menu'
import { useLivePreviewContext } from './live-preview-provider'
import { useTranslation } from 'react-i18next'

export default function LivePreviewCompileDropdownItem() {
  const live = useLivePreviewContext()
  const { t } = useTranslation()
  if (!live?.available) return null
  return (
    <>
      <DropdownHeader>{t('live_preview_section')}</DropdownHeader>
      {[true, false].map(enabled => (
        <li role="none" key={String(enabled)}>
          <DropdownItem
            as="button"
            trailingIcon={live.enabled === enabled ? 'check' : null}
            onClick={() => live.setEnabled(enabled)}
          >
            {t(enabled ? 'on' : 'off')}
          </DropdownItem>
        </li>
      ))}
      <DropdownDivider />
    </>
  )
}
