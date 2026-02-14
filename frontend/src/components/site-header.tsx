import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { useTranslation } from 'react-i18next'
import { useEffect, useState } from 'react'


export function SiteHeader() {
  const { i18n } = useTranslation()
  const [lang, setLang] = useState(i18n.language.startsWith('zh') ? 'zh' : 'en')
  useEffect(() => { i18n.changeLanguage(lang); try { localStorage.setItem('lang', lang) } catch {} }, [lang])
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="mx-2 data-[orientation=vertical]:h-4"
        />
        <div className="ml-auto flex items-center gap-2">
           <Button
            variant="ghost"
            size="icon"
            onClick={() => setLang(lang === 'en' ? 'zh' : 'en')}
            className="size-8"
            title={lang === 'en' ? 'Switch to Chinese' : 'Switch to English'}
          >
            {lang === 'en' ? <span className="text-xs font-bold">EN</span> : <span className="text-xs font-bold">中文</span>}
          </Button>
        </div>
      </div>
    </header>
  )
}
