// Stats row with count-up-on-scroll-into-view. Each number animates once,
// from 0 to its real value, over ~1000ms with an easeOutQuad curve.
// Respects prefers-reduced-motion by rendering the final value immediately.
import { Fragment, useEffect, useRef, useState } from "react";
import styles from "./StatsStrip.module.css";

export type Stat = {
  value: number;
  prefix?: string;
  suffix?: string;
  label: string;
};

const COUNT_UP_MS = 1000;
const easeOutQuad = (t: number) => t * (2 - t);

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function StatValue({ value, prefix = "", suffix = "" }: Stat) {
  const ref = useRef<HTMLSpanElement>(null);
  const [display, setDisplay] = useState(() => (prefersReducedMotion() ? value : 0));
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started.current) return;
        started.current = true;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min(1, (now - start) / COUNT_UP_MS);
          setDisplay(Math.round(easeOutQuad(t) * value));
          if (t < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  return (
    <span ref={ref} className={styles.value}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

export default function StatsStrip({
  stats,
  className,
}: {
  stats: Stat[];
  className?: string;
}) {
  return (
    <div className={[styles.strip, className].filter(Boolean).join(" ")}>
      {stats.map((stat, index) => (
        <Fragment key={stat.label}>
          {index > 0 && <div className={styles.divider} aria-hidden="true" />}
          <div className={styles.stat}>
            <StatValue {...stat} />
            <span className={styles.label}>{stat.label}</span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}
