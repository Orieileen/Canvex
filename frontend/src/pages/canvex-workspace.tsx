import CanvexPage from '@/pages/dashboard/canvex'
import { CanvexSidebar } from '@/components/canvex-sidebar'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import type { CSSProperties } from 'react'

export default function CanvexWorkspacePage() {
  return (
    <SidebarProvider
      style={{
        '--sidebar-width': 'calc(var(--spacing) * 60)',
      } as CSSProperties}
    >
      <CanvexSidebar variant="inset" />
      <SidebarInset>
        <div className="pointer-events-none absolute left-2 top-2 z-20 md:hidden">
          <SidebarTrigger className="pointer-events-auto size-8 border bg-background/90 shadow-sm backdrop-blur" />
        </div>
        <CanvexPage />
      </SidebarInset>
    </SidebarProvider>
  )
}
