import type { ButtonHTMLAttributes } from "react";

type Variant = "default" | "solid" | "outline";

const styles: Record<Variant, string> = {
  default:
    "border-2 border-nw-gold bg-transparent text-nw-gold hover:bg-nw-gold hover:text-nw-bg hover:nw-glow-strong",
  solid:
    "border-2 border-nw-gold bg-nw-gold text-nw-bg hover:bg-nw-gold-light hover:border-nw-gold-light",
  outline:
    "border border-nw-gold bg-transparent text-nw-gold hover:bg-nw-midnight hover:text-nw-fg",
};

export function Button({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      className={`inline-flex h-12 min-w-[10rem] items-center justify-center px-5 font-body text-xs tracking-[0.2em] uppercase transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nw-gold focus-visible:ring-offset-2 focus-visible:ring-offset-nw-bg disabled:cursor-not-allowed disabled:opacity-40 ${styles[variant]} ${className}`}
      {...props}
    />
  );
}
