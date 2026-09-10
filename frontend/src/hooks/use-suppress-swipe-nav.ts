import { useEffect } from "react";

/**
 * 压掉 macOS 触摸板「双指横滑 = 浏览器前进/后退」历史导航手势 —— 覆盖**整个 canvas
 * 页面**(画布 + 侧栏 + 所有 overlay)。
 *
 * 两道防线, **这里只是其中一道**:
 * 1. **CSS**(Chrome / Edge 的机制)—— 内联在 `index.html` 的 `<head>` 里, 规则本身和
 *    「为什么必须内联」都写在那儿。这里不复述, 也不抄那条选择器: 抄过来的那份改不动
 *    真的 CSS, 只会跟它分叉。它对整个文档常驻, 不随本 hook 挂卸。
 * 2. **JS**(Safari 唯一认的, 也就是本 hook): window 捕获阶段挂非被动 wheel 监听,
 *    横向为主(`|dx| > |dy|`)的手势一律 `preventDefault()`, 除非路径上有真正可横向
 *    滚动且仍有余量的容器(放行让它自己消费 —— 技能库那个 `<pre>` 就是, SKILL.md 里
 *    的英文提示词行很长)。纵向滚动(`|dx| <= |dy|`)提前返回, 不受影响。捕获阶段保证
 *    先于任何 `stopPropagation()` 的内层 handler 看到事件; Safari 的历史手势忽略
 *    overscroll-behavior、只认 preventDefault, 所以这一道删不掉。
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
      // 消费这次横滑, 不当作 swipe-nav 拦截。用 Element 起步, 兼容 target 是按钮里
      // <svg> 图标的情况。
      //
      // **先读 overflowX, 再读 scrollWidth —— 这个顺序是有代价的。** overflowX 只要
      // style, 而 scrollWidth 会强制一次同步 layout。实测最常见的那条路(画布上横滑,
      // 链上没有任何横向滚动容器): 整条链走完 41µs vs 2µs, 差的那 39µs 全是那一次被迫
      // 的 layout —— 而它发生在 Excalidraw 每帧都在弄脏 layout 的时候, 每秒 120 次。
      // 两个判断是「与」, 换序不改变行为。
      for (
        let node = e.target instanceof Element ? e.target : null;
        node;
        node = node.parentElement
      ) {
        const overflowX = getComputedStyle(node).overflowX;
        // 没有 "overlay" 那一支: Blink 把它并成了 auto, `getComputedStyle` 永远不会
        // 返回这个值 (Chrome 152 实测), 别的引擎从来没实现过。
        if (overflowX !== "auto" && overflowX !== "scroll") continue;
        // 仅当该容器在手势方向上还有滚动余量时才放行。滚到边界的横向容器若直接放行,
        // 多出来的 deltaX 会泄给浏览器照样触发返回 —— 到头的仍按 swipe-nav 拦掉。
        // 1px 容差是因为 scrollWidth / clientWidth 取整而 scrollLeft 是小数: 缩放或
        // 非整数布局下, "已经到头"会算出不到 1px 的假余量。
        // (不用再单独判 `scrollWidth > clientWidth` —— 不溢出时 maxScrollLeft <= 0,
        // 下面两个比较都为假, 这一句本身就把它挡掉了。)
        const maxScrollLeft = node.scrollWidth - node.clientWidth;
        const hasRoom =
          e.deltaX < 0 ? node.scrollLeft > 1 : node.scrollLeft < maxScrollLeft - 1;
        if (hasRoom) return;
      }
      // 路径上无横向滚动容器消费 → 这是返回手势, 压掉浏览器默认导航。
      e.preventDefault();
    };

    const opts: AddEventListenerOptions = { passive: false, capture: true };
    window.addEventListener("wheel", onWheel, opts);
    return () => window.removeEventListener("wheel", onWheel, opts);
  }, []);
}
