import { createBrowserRouter, Navigate } from 'react-router-dom'

import ErrorPage from '@/pages/error-page'
import CanvexWorkspacePage from '@/pages/canvex-workspace'

const router = createBrowserRouter([
  {
    path: '/',
    element: <CanvexWorkspacePage />,
    errorElement: <ErrorPage />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
])

export default router
