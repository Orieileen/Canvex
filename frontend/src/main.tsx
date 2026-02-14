import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'

import './index.css'
import './i18n'
import router from '@/Router'
import { Toaster } from '@/components/ui/sonner'

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string
  }
}

const assetPathRaw = import.meta.env.VITE_EXCALIDRAW_ASSET_PATH || '/excalidraw-assets/'
const assetPath = assetPathRaw.endsWith('/') ? assetPathRaw : `${assetPathRaw}/`
window.EXCALIDRAW_ASSET_PATH = assetPath

createRoot(document.getElementById('root')!).render(
  <>
    <RouterProvider router={router} />
    <Toaster />
  </>,
)
