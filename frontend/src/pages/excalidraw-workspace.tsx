import ExcalidrawPage from '@/pages/dashboard/excalidraw'
import { ExcalidrawSidebar } from '@/components/excalidraw-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import type { CSSProperties } from 'react'

export default function ExcalidrawWorkspacePage() {
  return (
    <SidebarProvider
      style={{
        '--sidebar-width': 'calc(var(--spacing) * 60)',
        '--header-height': 'calc(var(--spacing) * 10)',
      } as CSSProperties}
    >
      <ExcalidrawSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <ExcalidrawPage />
      </SidebarInset>
    </SidebarProvider>
  )
}
