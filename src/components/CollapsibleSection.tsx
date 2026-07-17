import { useEffect, useId, useState, type ReactNode } from "react";

type Props = {
  title: string;
  defaultOpen?: boolean;
  /** Když true, sekce se otevře (např. při varování). */
  forceOpen?: boolean;
  badge?: string | number | null;
  children: ReactNode;
  className?: string;
};

export function CollapsibleSection({
  title,
  defaultOpen = false,
  forceOpen = false,
  children,
  badge,
  className = "",
}: Props) {
  const [open, setOpen] = useState(defaultOpen || forceOpen);
  const bodyId = useId();

  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);

  return (
    <section
      className={`collapsible-section${open ? " is-open" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      <button
        type="button"
        className="collapsible-section-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="collapsible-section-title">{title}</span>
        {badge != null && badge !== "" && (
          <span className="collapsible-section-badge">{badge}</span>
        )}
        <span className="collapsible-section-chevron" aria-hidden>
          {open ? "▾" : "▴"}
        </span>
      </button>
      <div
        id={bodyId}
        className="collapsible-section-body"
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
