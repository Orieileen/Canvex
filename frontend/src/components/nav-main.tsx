// Tabler 图标库导入 - 用于主导航的图标
import { 
  IconCirclePlusFilled,  // 实心圆形加号图标 - 用于快速创建按钮
  IconMail,              // 邮件图标 - 用于收件箱按钮
  type Icon              // 图标类型定义
} from "@tabler/icons-react"

// React Router 导入 - 用于路由导航
import { Link, useLocation } from "react-router-dom"

// UI 组件导入
import { Button } from "@/components/ui/button"  // 按钮组件
import { useTranslation } from 'react-i18next'

// 侧边栏相关组件导入
import {
  SidebarGroup,        // 侧边栏分组容器
  SidebarGroupContent, // 侧边栏分组内容区域
  SidebarMenu,         // 侧边栏菜单容器
  SidebarMenuButton,   // 侧边栏菜单按钮
  SidebarMenuItem,     // 侧边栏菜单项
} from "@/components/ui/sidebar"

/**
 * NavMain 主导航组件
 * 
 * 功能说明：
 * - 渲染侧边栏的主要导航菜单
 * - 包含快速创建和收件箱功能按钮
 * - 动态渲染传入的导航菜单项
 * 
 * 布局结构：
 * ┌─────────────────────────────┐
 * │ Quick Create  │ Mail Button │ ← 功能按钮区
 * ├─────────────────────────────┤
 * │ Dashboard                   │ ← 动态菜单项
 * │ Lifecycle                   │
 * │ Analytics                   │
 * │ Projects                    │
 * │ Team                        │
 * └─────────────────────────────┘
 * 
 * @param items - 导航菜单项数组，包含标题、链接和图标
 */
export function NavMain({
  items,
}: {
  items: {
    title: string    // 菜单项标题
    url: string      // 菜单项链接地址
    icon?: Icon      // 可选的菜单项图标
  }[]
}) {
  // 获取当前路由位置 - 用于判断菜单项的活跃状态
  const location = useLocation()
  const { t } = useTranslation('sidebar')

  return (
    // 侧边栏分组容器 - 包含主导航的所有内容
    <SidebarGroup>
      <SidebarGroupContent className="flex flex-col gap-2">
        
        {/* 功能按钮区域 - 包含快速创建和收件箱按钮 */}
        <SidebarMenu>
          <SidebarMenuItem className="flex items-center gap-2">
            
            {/* 快速创建按钮 - 主色调背景，支持工具提示和路由跳转 */}
            <SidebarMenuButton
              // Tooltip follows current language
              tooltip={t('quickCreate')}
              className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground active:bg-primary/90 active:text-primary-foreground min-w-8 duration-200 ease-linear"
              // isActive={location.pathname === '/dashboard/create'}  // 当访问创建页面时高亮
              asChild>
              <Link to="/dashboard/create">  {/* 跳转到创建页面 */}
                <IconCirclePlusFilled />  {/* 加号图标 */}
                <span>{t('quickCreate')}</span>  {/* 按钮文字 */}
              </Link>
            </SidebarMenuButton>
            
            {/* 收件箱按钮 - 轮廓样式，侧边栏收起时隐藏，支持路由跳转 */}
            <Button
              size="icon"
              className="size-8 group-data-[collapsible=icon]:opacity-0"  // 收起状态时透明
              variant="outline"
              asChild>
              <Link to="/inbox">  {/* 跳转到收件箱页面 */}
                <IconMail />                           {/* 邮件图标 */}
                <span className="sr-only">{t('inbox')}</span> {/* 屏幕阅读器文本 */}
              </Link>
            </Button>
            
          </SidebarMenuItem>
        </SidebarMenu>
        
        {/* 动态导航菜单 - 根据传入的 items 数组渲染菜单项 */}
        <SidebarMenu>
          {items.map((item) => {
            // 精确判断当前菜单项是否为活跃状态
            let isActive: boolean = false
            
            if (item.url === '/dashboard') {
              // Dashboard 项只在完全匹配 /dashboard 时高亮，不包括子路由
              isActive = location.pathname === '/dashboard'
            } else {
              // 其他菜单项使用精确匹配
              isActive = location.pathname === item.url
            }
            
            return (
              <SidebarMenuItem key={item.title}>
                {/* 使用 asChild 属性将 SidebarMenuButton 渲染为 Link 组件 */}
                <SidebarMenuButton 
                  tooltip={item.title}
                  isActive={isActive}  // 传递活跃状态
                  asChild>
                  <Link to={item.url}>
                    {/* 条件渲染图标 - 如果提供了图标则显示 */}
                    {item.icon && <item.icon />}
                    {/* 菜单项标题 */}
                    <span>{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            )
          })}
        </SidebarMenu>
        
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
