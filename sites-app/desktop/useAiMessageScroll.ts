import { useCallback, useLayoutEffect, useRef, useState } from "react";

export function useAiMessageScroll(open: boolean, conversationId: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const lastScrollTop = useRef(0);
  const [showLatest, setShowLatest] = useState(false);

  const scrollToLatest = useCallback(() => {
    following.current = true;
    setShowLatest(false);
    const viewport = scrollRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      lastScrollTop.current = viewport.scrollTop;
    }
  }, []);

  const onScroll = useCallback(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const atBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 24;
    if (atBottom) following.current = true;
    else if (viewport.scrollTop < lastScrollTop.current) following.current = false;
    lastScrollTop.current = viewport.scrollTop;
    setShowLatest(!following.current && !atBottom);
  }, []);

  useLayoutEffect(() => {
    if (open) scrollToLatest();
  }, [open, conversationId, scrollToLatest]);

  // Follow DOM updates before paint, including the transition from draft to saved answer.
  useLayoutEffect(() => {
    if (open && following.current) scrollToLatest();
  });

  useLayoutEffect(() => {
    if (!open || !scrollRef.current || !contentRef.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scrollToLatest();
    });
    // Images, math fonts, reasoning disclosure, and composer resizing can change layout.
    observer.observe(scrollRef.current);
    observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [open, scrollToLatest]);

  return { scrollRef, contentRef, onScroll, scrollToLatest, showLatest };
}
