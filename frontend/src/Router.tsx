import { createBrowserRouter, Navigate } from 'react-router-dom'

import ErrorPage from '@/pages/error-page'
import ExcalidrawWorkspacePage from '@/pages/excalidraw-workspace'

const router = createBrowserRouter([
  {
    path: '/',
    element: <ExcalidrawWorkspacePage />,
    errorElement: <ErrorPage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])

export default router
