import { createContext, FC, useContext, useMemo, useState } from 'react'
import type PDFJSWrapper from '../util/pdf-js-wrapper'

const PdfPreviewContext = createContext<
  | {
      loadingError: boolean
      setLoadingError: (value: boolean) => void
      pdfJsWrapper: PDFJSWrapper | null
      initialised: boolean
      setPdfJsWrapper: (viewer: PDFJSWrapper | null) => void
      setInitialised: (value: boolean) => void
    }
  | undefined
>(undefined)

export const usePdfPreviewContext = () => {
  const context = useContext(PdfPreviewContext)
  if (!context) {
    throw new Error(
      'usePdfPreviewContext is only available inside PdfPreviewProvider'
    )
  }
  return context
}

export const PdfPreviewProvider: FC<React.PropsWithChildren> = ({
  children,
}) => {
  const [loadingError, setLoadingError] = useState(false)
  const [pdfJsWrapper, setPdfJsWrapper] = useState<PDFJSWrapper | null>(null)
  const [initialised, setInitialised] = useState(false)

  const value = useMemo(
    () => ({
      loadingError,
      setLoadingError,
      pdfJsWrapper,
      setPdfJsWrapper,
      initialised,
      setInitialised,
    }),
    [loadingError, pdfJsWrapper, initialised]
  )

  return (
    <PdfPreviewContext.Provider value={value}>
      {children}
    </PdfPreviewContext.Provider>
  )
}
