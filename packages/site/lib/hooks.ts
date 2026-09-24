"use client";

import { type RefObject, useEffect, useState } from "react";

/** True while the element is on screen. Animations use it to rest off screen. */
export function useInView(ref: RefObject<Element | null>, rootMargin = "0px"): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setSeen(Boolean(e?.isIntersecting)), {
      rootMargin,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [ref, rootMargin]);
  return seen;
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The path an asset is served at, under the site's base path. */
export const asset = (p: string) => `${process.env.NEXT_PUBLIC_BASE ?? ""}${p}`;
