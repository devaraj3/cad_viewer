// Shared scroll-reveal utility: translateY(8px) -> 0, opacity 0 -> 1, over
// 400ms ease-out. Fires once per element (observer disconnects on first
// intersection, never re-triggers on scroll back up). Respects
// prefers-reduced-motion by skipping straight to the revealed state.
//
// For a staggered group (e.g. a grid of cards), give each instance a
// `delayMs` a fixed step apart (~70ms) — each card observes independently,
// so cards that enter the viewport together animate in with that stagger,
// and a card scrolled to individually still reveals correctly on its own.
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";
import styles from "./Reveal.module.css";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export default function Reveal({
  as,
  delayMs = 0,
  distancePx = 8,
  durationMs = 400,
  className,
  children,
  ...rest
}: {
  as?: ElementType;
  delayMs?: number;
  /** Starting translateY offset, in px. Default 8 (matches the sitewide utility). */
  distancePx?: number;
  /** Transition duration, in ms. Default 400 (matches the sitewide utility). */
  durationMs?: number;
  className?: string;
  children: ReactNode;
  [key: string]: unknown;
}) {
  const Tag = (as ?? "div") as ElementType;
  const ref = useRef<HTMLElement | null>(null);
  const [revealed, setRevealed] = useState(prefersReducedMotion);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Tag
      ref={ref}
      className={[styles.reveal, revealed ? styles.revealed : "", className]
        .filter(Boolean)
        .join(" ")}
      style={
        {
          "--reveal-delay": `${delayMs}ms`,
          "--reveal-distance": `${distancePx}px`,
          "--reveal-duration": `${durationMs}ms`,
        } as CSSProperties
      }
      {...rest}
    >
      {children}
    </Tag>
  );
}
