import { useEffect } from "react";

/**
 * 压掉 macOS 触摸板「双指横滑 = 浏览器前进/后退」历史导航手势 —— 覆盖**整个 canvas
 * 页面**(画布 + 侧栏 + 所有 overlay), 仅在 canvas 路由挂载期间生效。
 *
 * 两道防线, **这里只是其中一道**:
 * 1. **CSS**(Chrome / Edge 的机制): `html { overscroll-behavior-x: none }`,
 *    **内联在 index.html 里**, 不在这个 hook 里也不在 index.css 里。
 *    原因见那段注释: 它必须在 bundle 下载 + React 挂载之前就生效, 否则"刷新之后
 *    立刻横滑一下"会真的把页面导航走 —— 那正是这道防线以前漏掉的窗口。
 * 2. **JS**(Safari 唯一认的, 也就是本 hook): window 捕获阶段挂非被动 wheel 监听,
 *    横向为主(`|dx| > |dy|`)的手势一律 `preventDefault()`, 除非路径上有真正可横向
 *    滚动且仍有余量的容器(放行让它自己消费, 如水平 chip 行)。纵向滚动
 *    (`|dx| <= |dy|`)提前返回, 不受影响。捕获阶段保证先于任何 `stopPropagation()`
 *    的内层 handler 看到事件; Safari 的历史手势忽略 overscroll-behavior、只认
 *    preventDefault。
 *
 * 挂 window 而非画布 pane: 画布**之外**(侧栏 / 顶栏 / 间隙)横滑同样会触发返回,
 * pane 级监听收不到那些事件。
 */
export function useSuppressSwipeNav() {
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      // 纵向为主的滚动放行 —— 面板 / 侧栏的垂直滚动必须保留。
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
      // 从事件源向上遍历: 命中任何可横向滚动且仍有横向余量的祖先就放行, 让它自己
      // 消费这次横滑(真正的水平滚动容器), 不当作 swipe-nav 拦截。用 Element 起步,
      // 兼容 target 是按钮里 <svg> 图标的情况。
      let node = e.target instanceof Element ? e.target : null;
      while (node) {
        if (node.scrollWidth > node.clientWidth) {
          const overflowX = getComputedStyle(node).overflowX;
          if (
            overflowX === "auto" ||
            overflowX === "scroll" ||
            overflowX === "overlay"
          ) {
            // 仅当该容器在手势方向上还有滚动余量时才放行。滚到边界的横向容器若直接
            // 放行, 多出来的 deltaX 会泄给浏览器照样触发返回 —— 到头的仍按 swipe-nav 拦掉。
            const maxScrollLeft = node.scrollWidth - node.clientWidth;
            const canScrollInDir =
              e.deltaX < 0 ? node.scrollLeft > 0 : node.scrollLeft < maxScrollLeft;
            if (canScrollInDir) return;
          }
        }
        node = node.parentElement;
      }
      // 路径上无横向滚动容器消费 → 这是返回手势, 压掉浏览器默认导航。
      e.preventDefault();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener("wheel", onWheel, opts);
    return () => window.removeEventListener("wheel", onWheel, opts);
  }, []);
}
