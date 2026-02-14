import { isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Link } from 'react-router-dom'

export default function ErrorPage() {
  const error = useRouteError() as any
  let title = 'Unexpected Application Error'
  let message = 'Something went wrong.'
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

