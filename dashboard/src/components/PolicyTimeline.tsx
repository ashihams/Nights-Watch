import type { CheckpointRow, PolicyEvalPoint, Thresholds } from "../lib/types";

export function PolicyTimeline({
  evaluations,
  checkpoints,
  thresholds,
  focusedStepId,
  onStepClick,
}: {
  evaluations: PolicyEvalPoint[];
  checkpoints: CheckpointRow[];
  thresholds: Thresholds;
  focusedStepId?: string | null;
  onStepClick?: (stepId: string) => void;
}) {
  const width = 640;
  const height = 220;
  const pad = { l: 40, r: 16, t: 16, b: 36 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const points = evaluations.length
    ? evaluations
    : [{ stepId: "—", score: 0, checkpointId: "", fired: [], timestamp: "" }];

  const xAt = (i: number) =>
    pad.l +
    (points.length <= 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const yAt = (score: number) => pad.t + innerH - (score / 100) * innerH;

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xAt(i)} ${yAt(p.score)}`)
    .join(" ");

  const thresh = [
    { label: "PAUSE", value: thresholds.pause },
    { label: "ROLLBACK", value: thresholds.rollback },
    { label: "HARD", value: thresholds.hardStop },
  ];

  const cpByEval = checkpoints.map((cp) => {
    const idx = evaluations.findIndex((e) => e.checkpointId === cp.id);
    const fallback = Math.min(cp.index, Math.max(evaluations.length - 1, 0));
    return { cp, i: idx >= 0 ? idx : fallback };
  });

  return (
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="min-w-full text-nw-fg"
        role="img"
        aria-label="Policy score timeline"
      >
        <rect
          x={pad.l}
          y={pad.t}
          width={innerW}
          height={innerH}
          fill="rgba(30,61,89,0.25)"
          stroke="rgba(212,175,55,0.25)"
        />
        {[0, 25, 50, 75, 100].map((s) => (
          <g key={s}>
            <line
              x1={pad.l}
              x2={pad.l + innerW}
              y1={yAt(s)}
              y2={yAt(s)}
              stroke="rgba(212,175,55,0.12)"
            />
            <text
              x={pad.l - 8}
              y={yAt(s) + 4}
              textAnchor="end"
              className="fill-nw-muted"
              style={{ fontSize: 10 }}
            >
              {s}
            </text>
          </g>
        ))}
        {thresh.map((t) => (
          <g key={t.label}>
            <line
              x1={pad.l}
              x2={pad.l + innerW}
              y1={yAt(t.value)}
              y2={yAt(t.value)}
              stroke="#D4AF37"
              strokeDasharray="4 4"
              strokeOpacity={0.55}
            />
            <text
              x={pad.l + innerW - 4}
              y={yAt(t.value) - 4}
              textAnchor="end"
              fill="#D4AF37"
              style={{ fontSize: 9, letterSpacing: "0.12em" }}
            >
              {t.label} {t.value}
            </text>
          </g>
        ))}
        <path d={line} fill="none" stroke="#D4AF37" strokeWidth={2} />
        {points.map((p, i) => {
          const spike = p.score >= thresholds.pause;
          const focused = focusedStepId === p.stepId;
          const clickable = p.stepId !== "—" && !!onStepClick;
          return (
            <g
              key={`${p.stepId}-${i}`}
              className={clickable ? "cursor-pointer" : undefined}
              onClick={clickable ? () => onStepClick?.(p.stepId) : undefined}
            >
              <circle
                cx={xAt(i)}
                cy={yAt(p.score)}
                r={focused ? 9 : spike ? 7 : 4}
                fill={spike ? "#F2E8C4" : "#D4AF37"}
                stroke={focused ? "#D4AF37" : "none"}
                strokeWidth={focused ? 2 : 0}
                className={spike ? "nw-spike" : undefined}
              />
              <text
                x={xAt(i)}
                y={height - 10}
                textAnchor="middle"
                className={focused ? "fill-nw-gold" : "fill-nw-muted"}
                style={{ fontSize: 10, letterSpacing: "0.08em" }}
              >
                {p.stepId.toUpperCase()}
              </text>
            </g>
          );
        })}
        {cpByEval.map(({ cp, i }) => (
          <g key={cp.id}>
            <line
              x1={xAt(i)}
              x2={xAt(i)}
              y1={pad.t}
              y2={pad.t + innerH}
              stroke="#1E3D59"
              strokeWidth={2}
            />
            <text
              x={xAt(i)}
              y={pad.t + 12}
              textAnchor="middle"
              fill="#F2F0E4"
              style={{ fontSize: 8, letterSpacing: "0.1em" }}
            >
              CP{cp.index}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
