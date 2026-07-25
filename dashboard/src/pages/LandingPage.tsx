import { Button } from "../components/Button";

const STEPS = [
  {
    roman: "I",
    title: "Plan",
    body: "Generate an approved travel plan with budget and expected tools.",
  },
  {
    roman: "II",
    title: "Execute",
    body: "n8n or the demo executor runs search → select → confirm → book.",
  },
  {
    roman: "III",
    title: "Observe",
    body: "Every step emits OTel spans into SigNoz, keyed by run.id.",
  },
  {
    roman: "IV",
    title: "Policy",
    body: "Rule-based Policy Engine scores the action against the plan (Query API for context).",
  },
  {
    roman: "V",
    title: "Recover",
    body: "On violation: explain, rollback to a local checkpoint, re-plan, resume.",
  },
] as const;

/** Replace with the final YouTube demo URL when recorded. */
const DEMO_VIDEO_URL = "https://www.youtube.com/watch?v=PLACEHOLDER";

export function LandingPage({
  onOpenDashboard,
}: {
  onOpenDashboard: () => void;
}) {
  return (
    <div className="min-h-screen">
      {/* Hero — brand-first, single composition */}
      <section className="relative flex min-h-[100svh] flex-col justify-end overflow-hidden px-6 pb-16 pt-24 md:px-12 md:pb-24">
        <div
          aria-hidden
          className="nw-sunburst pointer-events-none absolute inset-0"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-6 w-px bg-gradient-to-b from-transparent via-nw-gold/50 to-transparent md:left-12"
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-6 w-px bg-gradient-to-b from-transparent via-nw-gold/50 to-transparent md:right-12"
        />

        <div className="nw-enter relative z-10 mx-auto w-full max-w-6xl">
          <p className="font-display text-[clamp(3.5rem,14vw,9rem)] leading-[0.9] tracking-[0.08em] text-nw-gold uppercase">
            Nights
            <br />
            Watch
          </p>
          <div className="nw-rule-grow mt-8 h-px max-w-md bg-nw-gold" />
          <h1 className="mt-8 max-w-xl font-body text-lg tracking-[0.12em] text-nw-fg uppercase md:text-xl">
            Agents that don&apos;t fail loudly quietly drift off-plan
          </h1>
          <p className="mt-4 max-w-md text-base leading-relaxed text-nw-muted">
            Runtime resilience for AI agents — SigNoz as a control plane, not a
            passive dashboard.
          </p>
          <div className="mt-10 flex flex-wrap gap-4">
            <Button variant="solid" onClick={onOpenDashboard}>
              Open control room
            </Button>
            <Button
              variant="default"
              onClick={() =>
                window.open(DEMO_VIDEO_URL, "_blank", "noopener,noreferrer")
              }
            >
              Watch demo video
            </Button>
          </div>
        </div>
      </section>

      {/* Idea — split editorial */}
      <section className="relative border-t border-nw-gold/30 px-6 py-24 md:px-12 md:py-32">
        <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-12 md:gap-0">
          <div className="md:col-span-4 md:pr-10">
            <p className="text-xs tracking-[0.35em] text-nw-gold uppercase">
              The problem
            </p>
            <h2 className="mt-4 font-display text-3xl tracking-[0.14em] text-nw-fg uppercase md:text-4xl">
              Silent
              <br />
              drift
            </h2>
          </div>
          <div
            aria-hidden
            className="hidden w-px self-stretch bg-nw-gold/40 md:col-span-1 md:block md:justify-self-center"
          />
          <div className="space-y-6 text-lg leading-relaxed text-nw-fg/90 md:col-span-7 md:pl-10">
            <p>
              AI agents fail silently in a specific way: not by getting hacked,
              but by quietly doing more than they were asked. An agent told to
              find a flight under $400 that books a $1,200 upgrade hasn&apos;t
              been attacked — it has drifted out of scope.
            </p>
            <p>
              Nights Watch watches execution against the original plan, scores
              each action, explains violations in plain language, rolls back to
              the last safe checkpoint, re-plans, and resumes — without
              restarting from scratch. The Policy Engine queries SigNoz live at
              decision time; observability is an active input, not a postmortem
              archive.
            </p>
          </div>
        </div>
      </section>

      {/* How it works — horizontal process */}
      <section className="relative border-t border-nw-gold/30 bg-nw-card/40 px-6 py-24 md:px-12 md:py-32">
        <div className="mx-auto max-w-7xl">
          <div className="mb-14 text-center">
            <p className="text-xs tracking-[0.35em] text-nw-gold uppercase">
              Architecture
            </p>
            <h2 className="mt-3 font-display text-3xl tracking-[0.2em] text-nw-fg uppercase">
              How it works
            </h2>
          </div>

          <ol className="relative flex gap-6 overflow-x-auto pb-4 md:grid md:grid-cols-5 md:gap-4 md:overflow-visible md:pb-0">
            <div
              aria-hidden
              className="pointer-events-none absolute top-[1.15rem] right-4 left-4 hidden h-px bg-nw-gold/35 md:block"
            />
            {STEPS.map((s) => (
              <li
                key={s.roman}
                className="relative z-10 flex w-[12.5rem] shrink-0 flex-col items-center text-center md:w-auto"
              >
                <span className="flex h-9 w-9 rotate-45 items-center justify-center border border-nw-gold bg-nw-bg nw-glow">
                  <span className="-rotate-45 font-display text-sm text-nw-gold">
                    {s.roman}
                  </span>
                </span>
                <h3 className="mt-5 font-display text-lg tracking-[0.18em] text-nw-gold uppercase">
                  {s.title}
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-nw-muted">
                  {s.body}
                </p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Differentiator */}
      <section className="relative border-t border-nw-gold/40 px-6 py-24 md:px-12 md:py-28">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-nw-gold to-transparent"
        />
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-xs tracking-[0.35em] text-nw-gold uppercase">
            What makes this different
          </p>
          <p className="mt-8 font-display text-2xl leading-snug tracking-[0.06em] text-nw-fg md:text-3xl">
            Not another pretty traces page. Drift is scored against an approved
            plan, explained, rolled back from a local checkpoint store, and
            resumed — with SigNoz on the decision path.
          </p>
        </div>
      </section>
    </div>
  );
}
