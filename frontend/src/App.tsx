import { HeroSection } from '@/pages/sections/HeroSection'
import { FeaturesSection } from '@/pages/sections/FeaturesSection'
import { LegacySection } from '@/pages/sections/LegacySection'
import { useEffect, useRef } from 'react'
import Lenis from 'lenis'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import PricingSection from './pages/sections/pricingSection'

// 扩展 Window 接口以包含 Lenis 实例
declare global {
  interface Window {
    lenis?: Lenis | null;
  }
}

// 注册 GSAP 插件
gsap.registerPlugin(ScrollTrigger)

function App() {
  const lenisRef = useRef<Lenis | null>(null)

  useEffect(() => {
    // 页面刷新检测 - 确保刷新后始终回到页面顶部
    const handlePageLoad = () => {
      // 检测是否为页面刷新或重新加载
      const isReload = performance.navigation?.type === 1 || // legacy API
                      (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming)?.type === 'reload'; // modern API
      
      if (isReload || window.scrollY > 0) {
        // 立即滚动到顶部，不使用动画以避免与后续的Lenis初始化冲突
        window.scrollTo(0, 0);
        
        // 重置浏览器的滚动恢复行为
        if ('scrollRestoration' in history) {
          history.scrollRestoration = 'manual';
        }
      }
    };
    
    // 执行页面加载检查
    handlePageLoad();
    
    // 初始化 Lenis
    lenisRef.current = new Lenis({
      duration: 2,
      easing: (t: number) => 1 - Math.pow(1 - t, 4),
      smooth: true,
      smoothTouch: true, // 移动端保持原生滚动
      touchMultiplier: 2,
      infinite: false,
    })

    // 将 Lenis 与 GSAP ScrollTrigger 集成
    lenisRef.current.on('scroll', ScrollTrigger.update)
    
    // 将 Lenis 实例暴露到全局，供其他组件使用
    window.lenis = lenisRef.current

    // 禁用 ScrollTrigger 的刷新延迟，以获得更好的性能
    gsap.ticker.lagSmoothing(0)

    // 启动 Lenis 动画循环
    function raf(time: number) {
      lenisRef.current?.raf(time)
      requestAnimationFrame(raf)
    }

    requestAnimationFrame(raf)

    // 全局进度条动画
    const progressBar = document.querySelector(".progress-indicator");
    if (progressBar) {
      ScrollTrigger.create({
        trigger: document.body,
        start: "top top",
        end: "bottom bottom",
        scrub: 0.3,
        onUpdate: (self) => {
          gsap.set(progressBar, { scaleX: self.progress });
        }
      });
    }

    // 清理函数
    return () => {
      if (lenisRef.current) {
        lenisRef.current.destroy()
      }
      window.lenis = null
      ScrollTrigger.killAll()
    }
  }, [])

  return (
    <div className="min-h-screen">
      {/* Global Progress indicator */}
      <div className="fixed top-0 left-0 w-full h-1 bg-muted z-50">
        <div className="progress-indicator h-full bg-primary origin-left scale-x-0"></div>
      </div>
      
      <HeroSection />
      <FeaturesSection />
      <LegacySection />
      <PricingSection />
    </div>
  )
}

export default App