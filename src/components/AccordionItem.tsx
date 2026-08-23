// Shared FAQ accordion entry, used on Landing and both guide pages so the
// open/close interaction (height transition + chevron rotation) is
// identical everywhere instead of three copies of native <details> markup.
// Each item opens/closes independently — no shared "only one open" state.
import { useState, type ReactNode } from "react";
import styles from "./Accordion.module.css";

export default function AccordionItem({
  question,
  answer,
  className,
  icon = "chevron",
  children,
}: {
  question: string;
  answer: ReactNode;
  className?: string;
  /** "chevron" (default, used on the guide pages) rotates 180deg on open.
   * "plus" (used on Landing) turns a + into a x at 45deg. */
  icon?: "chevron" | "plus";
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={[styles.item, className].filter(Boolean).join(" ")}>
      {children}
      <button
        type="button"
        className={styles.trigger}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span>{question}</span>
        {icon === "plus" ? (
          <span
            className={[styles.plusIcon, open ? styles.plusIconOpen : ""]
              .filter(Boolean)
              .join(" ")}
            aria-hidden="true"
          >
            +
          </span>
        ) : (
          <svg
            className={[styles.chevron, open ? styles.chevronOpen : ""]
              .filter(Boolean)
              .join(" ")}
            viewBox="0 0 16 16"
            width="14"
            height="14"
            aria-hidden="true"
            focusable="false"
          >
            <path
              d="M4 6 L8 10 L12 6"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </button>
      <div
        className={[styles.contentWrap, open ? styles.contentOpen : ""]
          .filter(Boolean)
          .join(" ")}
      >
        <div className={styles.contentInner}>
          <p className={styles.answer}>{answer}</p>
        </div>
      </div>
    </div>
  );
}
