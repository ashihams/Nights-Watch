import type { ReactNode } from "react";

export function DecoCard({
  title,
  children,
  className = "",
  accent,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
  accent?: boolean;
}) {
  return (
    <section
      className={`relative border border-nw-gold/30 bg-nw-card p-6 transition-all duration-500 hover:-translate-y-0.5 hover:border-nw-gold hover:nw-glow ${accent ? "nw-glow" : ""} ${className}`}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute left-2 top-2 h-3 w-3 border-l-2 border-t-2 border-nw-gold/60"
      />
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-2 right-2 h-3 w-3 border-b-2 border-r-2 border-nw-gold/60"
      />
      {title ? (
        <header className="mb-4 border-b border-nw-gold/20 pb-3">
          <h2 className="font-display text-xl tracking-[0.2em] text-nw-gold uppercase">
            {title}
          </h2>
        </header>
      ) : null}
      {children}
    </section>
  );
}
