import CanvexPage from '@/pages/dashboard/canvex'
import { CanvexSidebar } from '@/components/canvex-sidebar'
import { SiteHeader } from '@/components/site-header'
import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import type { CSSProperties } from 'react'

export default function CanvexWorkspacePage() {
  return (
    <SidebarProvider
      style={{
        '--sidebar-width': 'calc(var(--spacing) * 60)',
        '--header-height': 'calc(var(--spacing) * 10)',
      } as CSSProperties}
    >
      <CanvexSidebar variant="inset" />
      <SidebarInset>
        <SiteHeader />
        <CanvexPage />
      </SidebarInset>
    </SidebarProvider>
  )
}
