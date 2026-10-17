import {
  OLDropdownDivider,
  OLDropdownHeader,
  OLDropdownItem,
} from '@/shared/components/ol/ol-dropdown-menu'
import { useLivePreviewContext } from './live-preview-provider'
import { useTranslation } from 'react-i18next'

export default function LivePreviewCompileDropdownItem() {
  const live = useLivePreviewContext()
  const { t } = useTranslation()
  if (!live?.available) return null
  return (
    <>
      <OLDropdownHeader>{t('live_preview_section')}</OLDropdownHeader>
      {[true, false].map(enabled => (
        <li role="none" key={String(enabled)}>
          <OLDropdownItem
            as="button"
            trailingIcon={live.enabled === enabled ? 'check' : null}
            onClick={() => live.setEnabled(enabled)}
          >
            {t(enabled ? 'on' : 'off')}
          </OLDropdownItem>
        </li>
      ))}
      <OLDropdownDivider />
    </>
  )
}
