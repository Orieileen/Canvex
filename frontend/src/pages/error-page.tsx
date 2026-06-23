import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { useTranslation } from 'react-i18next'

export default function ErrorPage() {
  const { t } = useTranslation('canvasUi')
  const error = useRouteError() as any
  let title = t('errorPage.title')
  let message = t('errorPage.message')
  if (isRouteErrorResponse(error)) {
    title = `${error.status} — ${error.statusText}`
    message = (error.data && (error.data.message || error.data)) || message
  } else if (error && (error as Error).message) {
    message = (error as Error).message
  }
  return (
    <div className="min-h-svh flex flex-col items-center justify-center px-6 text-center">
      <h1 className="text-2xl font-bold mb-2">{title}</h1>
      <p className="text-muted-foreground mb-6 max-w-[48ch]">{String(message)}</p>
    </div>
  )
}
