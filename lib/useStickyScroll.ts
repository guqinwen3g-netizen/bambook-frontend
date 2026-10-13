import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 粘性自动滚动 hook（Cursor / Claude 用同款范式）。
 *
 * 设计意图：
 *   - 用户在底部时，新内容到来要自动跟随
 *   - 用户主动上滚阅读历史时，禁止 hijack —— 即使 deps 变化也不打断阅读
 *   - 用户重新滚到底部，恢复跟随
 *   - 暴露 `scrollToBottom()` 方便"回到底部"按钮主动触发
 *
 * 阈值 BOTTOM_THRESHOLD：距底部 80px 内视为"贴底"
 *
 * 用法：把已有的 scrollRef 直接传进来（避免和现有 ScrollEdgeFades 等组件抢 ref）。
 *
 * @param scrollRef  容器 ref（外部已经持有）
 * @param deps       触发自动滚动的依赖（如 messages、agentEvents 长度）
 * @returns isPinnedToBottom + scrollToBottom
 */
const BOTTOM_THRESHOLD = 80;

export function useStickyScroll(
  scrollRef: React.RefObject<HTMLElement | null>,
  deps: ReadonlyArray<unknown>,
) {
  const isPinnedRef = useRef(true);
  const [isPinnedToBottom, setIsPinnedToBottom] = useState(true);

  // 监听用户主动滚动，更新 pinned 状态
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distanceFromBottom <= BOTTOM_THRESHOLD;
      isPinnedRef.current = pinned;
      setIsPinnedToBottom(prev => (prev === pinned ? prev : pinned));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef]);

  // deps 变化 → 仅当贴底时自动跟随
  useEffect(() => {
    if (!isPinnedRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
    isPinnedRef.current = true;
    setIsPinnedToBottom(true);
  }, [scrollRef]);

  return { isPinnedToBottom, scrollToBottom };
}
