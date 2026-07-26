# Nights Watch — Demo Script (under 5 minutes)

Timed walkthrough for judges. **Target: ~4:30.** Rehearse twice with a stopwatch before presenting.

**Live control room:** https://nights-watch-control.vercel.app/  
Free live link (Vercel UI + Render API; SigNoz = local video): see [README — Live deployment](./README.md#live-deployment).

**Tabs to pre-open**

| Tab | URL | Purpose |
|---|---|---|
| Control room | Live URL `/dashboard` (or http://localhost:5173/dashboard) | Live Policy Score, approval, feed |
| SigNoz Traces | SSH tunnel → http://localhost:8080 (not public on VPS) | Correlated `run.execute` waterfall |
| (Optional) Landing | Live URL `/` (or http://localhost:5173) | 10-second pitch slide |

**Pre-flight (before you start speaking)**

```bash
# Always-on VPS (preferred for judges): stack already up — just open Live URL.
# Local rehearsal:
foundryctl cast -f casting.yaml   # skip if already healthy
docker compose up --build -d
# VPS overlay (loopback binds): docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

Confirm: health ok · dashboard loads · SigNoz via SSH tunnel if you need the waterfall live (else use backup video).

---

## 0:00–0:40 · Pitch (landing or one sentence)

**Say:**  
“AI agents fail silently by *drifting* — doing more than they were asked. Nights Watch treats **SigNoz as a control plane**, not a dashboard: we score every step against the approved plan, explain the violation, pause for a human, roll back from a **local** checkpoint, and resume — without restarting from scratch.”

**Show (optional):** landing page brand + “Open control room”.

**Click:** Open control room → dashboard.

---

## 0:40–1:10 · Architecture in one breath

**Say (point at README Mermaid or just speak):**  
“n8n or our demo executor *acts*. The TypeScript Supervisor *decides*. Policy Engine talks to SigNoz **Query API** every step. Explanations use **SigNoz MCP**. Rollback never reads SigNoz — only SQLite checkpoints. That split is the whole design.”

Do **not** deep-dive Foundry here — one line max: “SigNoz itself is reproducible from our repo-root `casting.yaml`.”

---

## 1:10–2:40 · Live inject-drift (main beat)

**Click:** **Start run (inject drift)**  
Task: find/book SFO→LAX under **$400**. Poisoned search includes a **$1,200** luxury option.

| Time | What happens on screen | What you say |
|---|---|---|
| ~1:15 | Search completes, score ~0, feed: in-policy | “Happy path starts — Policy Score stays low.” |
| ~1:25 | Select $1200 → score spikes to **40** (pause) | “Executor picks the upgrade. Budget breach fires. Score crosses pause.” |
| ~1:30 | Explanation card + **Human approval required** | “Plain-language why — MCP may be degraded; fallback still explains the rule. Medium severity **pauses** for a human.” |
| ~1:40 | **Click Reject & recover** | “We reject the out-of-scope action.” |
| ~1:45 | Feed: approval → recovery; timeline rolls back | “Recovery Engine restores the last **local** checkpoint, re-plans, resumes.” |
| ~2:00 | Re-select in-budget → confirm → **pre_irreversible** CP | “Before book — irreversible step — Checkpoint Manager forces a `pre_irreversible` snapshot.” |
| ~2:20 | Book completes; Recovery Health ticks up | “Original goal finished in scope. Recovered execution counted.” |

**If something stalls:** fall back to CLI (pre-rehearsed in another terminal):

```bash
cd backend && npm run happy-path:drift
```

CLI auto-rejects medium pause so the story still completes.

---

## 2:40–3:50 · SigNoz proof (same `run.id`)

**Copy** `run.id` from the dashboard (e.g. `run-a1b2c3d4`).

**In SigNoz → Traces** (local: `:8080`; VPS: `ssh -L 8080:127.0.0.1:8080 user@vps` — SigNoz is never on the judge URL)

1. Filter: `service.name = nights-watch` and attribute `run.id = <id>`
2. Open **`run.execute`** (waterfall / children, not root-only)

**Point at, quickly:**

| Span / event | One-line meaning |
|---|---|
| `executor.step` | Agent actions |
| `policy.evaluation` | Score + rules |
| `policy.explanation` | Why (MCP/LLM) |
| `run.awaiting_approval` / `human.decision` | Human in the loop |
| `checkpoint.created` with `pre_irreversible` | Safety net before book |
| `checkpoint.restored` + `recovery.outcome` | Rollback from local store, observed in SigNoz |

**Say:**  
“Same `checkpoint.id` in SQLite and in this span — SigNoz for visibility; SQLite for restore. Query API fed the Policy Engine; MCP fed the explanation. That’s the control plane.”

---

## 3:50–4:20 · Close + future scope (one sentence)

**Say:**  
“Shipped through Phase 7: plan, checkpoints, policy, explain, recover, live UI, human approval, irreversible pre-book CP. **Next** is dynamic budget tracking — a live spend gauge and a hard-stop on ceiling even when Policy Score alone wouldn’t fire. Casting and lock are in the repo so you can re-run Foundry and reproduce SigNoz.”

**Optional:** flash `casting.yaml` in the repo for 5 seconds.

---

## 4:20–4:30 · Buffer / Q&A bait

Stop. Invite one question. Backup answers:

| Question | Short answer |
|---|---|
| Why not roll back from SigNoz? | Latency + not source of truth; Supervisor must work if SigNoz blips. |
| Why MCP and Query API both? | Policy needs fast typed queries every step; explanations are rare and exploratory. |
| What if I Approve? | Run continues; further medium pauses bypassed for that run (demo path is Reject). |

---

## Timing cheat-sheet

| Block | Seconds |
|---|---|
| Pitch | 40 |
| Architecture | 30 |
| Live drift + reject | 90 |
| SigNoz waterfall | 70 |
| Close + future | 30 |
| Buffer | 10 |
| **Total** | **~270 (~4:30)** |

---

## Backup if live UI fails

1. Play pre-recorded demo video (Phase 8 backup recording).  
2. Or narrate over `npm run happy-path:drift` logs + SigNoz trace already open from a prior run.  
3. Local checkpoints: `cd backend && npm run checkpoints:list -- <runId>`.

---

## Rehearsal checklist

- [ ] Rehearsed **twice** timed under 5:00  
- [ ] Inject-drift reliably hits score 40 and approval panel  
- [ ] Reject path completes booking  
- [ ] SigNoz shows `pre_irreversible` + `human.decision` for that `run.id`  
- [ ] Backup video recorded (required if judges cannot SSH to SigNoz)  
- [ ] Always-on Live URL verified on **mobile data** (README checklist)  
- [ ] `docker compose` + Foundry stack healthy before entering the room  
