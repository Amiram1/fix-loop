# FixLoop — Implementation Plan

FixLoop is an open-source GitHub Action that triages and fixes bugs reported as GitHub issues.
It plugs into any repo with one workflow file and one `.fixloop.yml`. Vikunja (Go/Vue) is the reference target only.

**Decisions:** TypeScript · everything runs in GitHub (Actions = runtime + sandbox, Issues/PRs = UI, repo branch = memory/ledger, Pages = dashboard).

---

## 1. How a target repo connects

```yaml
# target-repo/.github/workflows/fixloop.yml
on:
  issues: { types: [opened, labeled] }
  issue_comment: { types: [created] }          # /fixloop retry|stop, reporter replies
  pull_request_review: { types: [submitted] }  # review feedback → another fix pass
  repository_dispatch: { types: [fixloop-slack] } # Slack replies (via relay, see §7)
permissions: { contents: write, issues: write, pull-requests: write }
concurrency: { group: fixloop-${{ github.event.issue.number || github.event.pull_request.number }}, cancel-in-progress: false }
jobs:
  fixloop:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: fixloop/fixloop@v1
        with:
          anthropic-api-key: ${{ secrets.ANTHROPIC_API_KEY }}
          slack-webhook: ${{ secrets.FIXLOOP_SLACK_WEBHOOK }}   # optional
```

```yaml
# target-repo/.fixloop.yml
app:
  up: docker compose -f docker-compose.fixloop.yml up -d --wait
  down: docker compose -f docker-compose.fixloop.yml down -v
  base_url: http://localhost:3456
  seed: ./scripts/fixloop-seed.sh          # creates test user + data via API
logs:
  - { type: docker, services: [api, web] }
  - { type: file, path: /tmp/vikunja/*.log }
traces: { type: otel-file, path: /tmp/otel/traces.json }   # optional
tests:
  backend:  { run: "go test ./pkg/... -run {{name}}", dir: ., new_test_glob: "pkg/**/*_test.go" }
  frontend: { run: "pnpm playwright test {{file}}", dir: frontend, new_test_glob: "frontend/tests/e2e/fixloop/*.spec.ts" }
  full:     "make test"
areas:                       # helps classification + risk
  backend:  ["pkg/**", "*.go"]
  frontend: ["frontend/src/**"]
risk:
  high_paths: ["pkg/user/**", "pkg/modules/auth/**", "pkg/migration/**"]
  max_diff_lines: 150
autonomy:                    # what FixLoop may do per gate level
  ready_pr_min_confidence: 0.8
  draft_pr_min_confidence: 0.5
budget: { per_run_usd: 1.50, max_fix_iterations: 4 }
models: { triage: claude-haiku-5-5, fix: claude-sonnet-5-5, escalate: claude-opus-5-5 }
notify:
  slack: { min_severity: high, on: [escalation, pr_ready] }
  linear: { enabled: false }
```

### CLI (`npx fixloop`)

A second entry point (`src/cli.ts`) next to the Action (`src/index.ts`). It shares the same pipeline, config schema and adapters, so it's one package, one build and one test suite.

- **`fixloop init`** makes "connect as quickly as possible" real:
  - detects the stack (`go.mod`, `package.json`, `docker-compose*`) and drafts `.fixloop.yml`
  - writes `.github/workflows/fixloop.yml`
  - sets secrets via `gh secret set` (ANTHROPIC_API_KEY, optional Slack webhook)
  - creates the `fixloop-data` orphan branch and the `fixloop:*` / `needs-info` labels
  - smoke-checks that `app.up` boots, health passes and the test commands run
- **`fixloop run --issue <n> [--dev] [--stage <name>] [--dry-run]`** runs the pipeline locally against a real issue. You can iterate on stages without pushing and waiting for Actions. `--dev` forces Haiku, and `--dry-run` skips GitHub writes (it prints the comment and PR body instead).
- **`fixloop eval [--bugs <glob>]`** replays the seeded corpus (replaces standalone `evals/replay.ts`) and prints success rate, cost, time and cumulative dev spend.

---

## 2. Pipeline

```
issue event
  │
  ▼
0. Guard        authorized trigger? not a dup run? budget left? → else exit quietly
1. Intake       (Haiku)  sanitize → summarize → dedupe vs open issues → area FE/BE → severity S1–S4 → labels
2. Context      codebase brief (cached) + fix-journal hits + CODEOWNERS + recent commits on suspect paths
3. Boot         `app.up` + `seed`, health-check; collect logs/traces baseline
4. Reproduce    (Sonnet agent) write failing test (Go test / Playwright); MUST go red
       └─ fail → ask reporter on issue (needs-info) → stop; resumes on reply
5. Fix loop     (Sonnet → Opus after 2 failures) patch → targeted test green → full suite green
       └─ budget/iterations exhausted → diagnosis comment + escalate
6. Gate         confidence × risk → READY_PR | DRAFT_PR | DIAGNOSIS_ONLY
7. Deliver      branch fixloop/issue-N, PR (body template), reviewer from CODEOWNERS/blame, labels
8. Notify       update single status comment; Slack only if gate says human needed or severity high
9. Learn        append fix-journal entry; append run ledger; refresh dashboard data
```

Every stage writes a `StageResult` to the ledger, so a failed run tells you where and why it stopped.

### Gate logic (deterministic, not LLM)
```
confidence = 0.35·reproduced_red + 0.25·targeted_green + 0.2·suite_green
           + 0.1·(diff ≤ max_diff_lines) + 0.1·llm_self_assessment
risk_high  = touches risk.high_paths || (severity == S1 && corroborated) || diff > max_diff_lines
            # corroborated: a changed file is in high_paths, or the issue text has a security or data keyword;
            # an uncorroborated S1 counts as S2, because the model flips S1 and S2 between runs
READY_PR       if confidence ≥ 0.8 && !risk_high
DRAFT_PR       if confidence ≥ 0.5
DIAGNOSIS_ONLY otherwise (comment root-cause hypothesis + evidence + escalate)
```
Never auto-merge in v1.

---

## 3. Repo layout (this repo)

```
fix-loop/
├─ action.yml                     # composite/node20 action entry
├─ package.json  tsconfig.json  vitest.config.ts
├─ src/
│  ├─ index.ts                    # Action entry: parse event → route
│  ├─ cli.ts                      # CLI entry (commander): init | run | eval
│  ├─ cli/{init,run,eval}.ts      # init: stack detection, gh secrets, labels, data branch, smoke check
│  ├─ router.ts                   # event → command (new run / resume / retry / stop / review-feedback)
│  ├─ config/
│  │  ├─ schema.ts                # zod schema for .fixloop.yml
│  │  └─ load.ts
│  ├─ pipeline/
│  │  ├─ run.ts                   # orchestrates stages, budget, ledger
│  │  ├─ guard.ts
│  │  ├─ intake.ts                # Haiku: summarize/dedupe/classify/severity
│  │  ├─ context.ts               # brief + journal retrieval + owners
│  │  ├─ boot.ts                  # app up/seed/health, log capture
│  │  ├─ reproduce.ts             # agent: write failing test
│  │  ├─ fix.ts                   # agent: patch until green, model escalation
│  │  ├─ gate.ts                  # deterministic scoring
│  │  ├─ deliver.ts               # branch, commit, PR
│  │  ├─ notify.ts
│  │  └─ learn.ts
│  ├─ agent/
│  │  ├─ client.ts                # Claude Agent SDK wrapper, prompt caching, cost tracking
│  │  ├─ tools.ts                 # scoped tools: read/grep/edit (repo only), run_test, http_get app, read_logs
│  │  ├─ budget.ts                # USD + iteration caps, throws BudgetExceeded
│  │  └─ prompts/                 # intake.md, reproduce.md, fix.md, brief.md, journal.md
│  ├─ memory/
│  │  ├─ brief.ts                 # generate/refresh codebase brief (keyed by main SHA + changed dirs)
│  │  ├─ journal.ts               # fix journal: append + retrieve (keyword/path overlap; no vector DB)
│  │  └─ store.ts                 # read/write files on `fixloop-data` orphan branch
│  ├─ adapters/
│  │  ├─ github.ts                # octokit: issues, comments, labels, PRs, CODEOWNERS, blame
│  │  ├─ logs/{docker,file}.ts
│  │  ├─ traces/otelFile.ts
│  │  ├─ notify/{slack,linear}.ts # linear = stub behind interface
│  │  └─ types.ts                 # LogSource, Notifier, Tracker interfaces
│  ├─ ui/
│  │  ├─ statusComment.ts         # single comment, edited in place (hidden marker)
│  │  └─ prBody.ts
│  ├─ security/sanitize.ts        # untrusted issue text → fenced data, strip tool-like directives
│  └─ metrics/ledger.ts           # JSONL append + aggregates
├─ dashboard/                     # static page (GitHub Pages) reading ledger JSON from fixloop-data
├─ evals/
│  ├─ bugs/                       # seeded bug corpus: patch + issue text + expected files
│  └─ manifest.json               # corpus index consumed by `fixloop eval`
├─ examples/vikunja/              # .fixloop.yml, docker-compose.fixloop.yml, seed script, workflow
├─ test/                          # unit tests (gate, config, sanitize, router, journal retrieval)
└─ docs/WRITEUP.md
```

**State lives in the target repo** on an orphan branch `fixloop-data`:
```
brief/<main-sha>.md
journal/<issue>.json
ledger/runs.jsonl
runs/<issue>/<run-id>/{transcript.json, logs.txt, screenshots/}
```
No database and no external service; it's all git and inspectable.

---

## 4. Memory design (bug #1 → bug #2)

- **Codebase brief** (~3–5k tokens): stack, how to run/test, directory map, key modules, conventions. Built once by Sonnet, cached on `fixloop-data`, partially refreshed when top-level dirs change. Always sent as the first cached system block (prompt caching makes it nearly free across stages).
- **Fix journal entry** (written by Haiku at end of run):
  `{ issue, area, symptoms, root_cause, files, repro_recipe, fix_pattern, pitfalls, tokens, duration }`
- **Retrieval:** score entries by area match + path overlap with suspected files + keyword overlap with the summary; inject top 3. Simple and deterministic, with no embeddings needed at this scale.
- **Repro recipes** are the biggest win: e.g. "FE: login via `/api/v1/login`, set token in localStorage, then Playwright." Bug #2 reuses the harness instead of rediscovering it. **Demo metric:** bug #2 tokens/time vs bug #1.

---

## 5. Measurement

Ledger row per run: `issue, area, severity, gate, reproduced, iterations, models_used, usd, tokens_in/out/cached, t_triage, t_repro, t_pr, human_touches, outcome`.
Outcome is filled later by a lightweight `pull_request: closed` handler: `merged | closed | reverted`.

Dashboard (Pages): MTTR-to-PR, repro rate, PR merge rate, cost per bug, % handled without human, escalation reasons.
**Business framing:** engineer-hours saved per bug and reduced MTTR, with false-positive PRs as the counter-metric.

`fixloop eval`: run the seeded corpus (start with the 2 demo bugs + 3–4 extras) to get a reproducible success rate before and after prompt changes.

---

## 6. Cost plan

### 6a. Development budget ($50 total — building FixLoop, not operating it)

The provided $50 API key covers developing and testing FixLoop, not ongoing bug-fixing in production.

| Bucket | Models | Allocation |
|---|---|---|
| Iterating on prompts/stages (bulk of dev runs) | Haiku only (`FIXLOOP_DEV=1`) | ~$10 |
| Integration runs against Vikunja in Actions | Haiku, occasional Sonnet | ~$10 |
| Replay evals (corpus, a few rounds) | Production model mix | ~$12 |
| Final demo runs + recording retakes | Production model mix | ~$8 |
| Reserve (debugging, Opus escalation tests) | Any | ~$10 |

Track it in the ledger: every run, including dev and eval runs, records `usd`, and `fixloop eval` prints cumulative spend. Stop and re-plan at $35.

### 6b. Operating cost per bug (what a team adopting FixLoop would pay)

| Stage | Model | Est. per run |
|---|---|---|
| Intake + journal write | Haiku | $0.01–0.03 |
| Brief (one-time per repo) | Sonnet | ~$0.30 |
| Reproduce + fix | Sonnet | $0.30–1.00 |
| Escalation (rare) | Opus | ≤ $1.00, hard-capped |

Expect roughly $0.50–2.00 per bug. In production, `budget.per_run_usd` caps each run, and an optional monthly cap in the ledger refuses new runs once it's reached.

---

## 7. Human-in-the-loop

- **Status comment** on the issue (single, edited): stage checklist, severity, root cause, PR link, cost.
- **Commands** (repo collaborators only): `/fixloop retry`, `/fixloop stop`, `/fixloop escalate`, `/fixloop hint <text>`.
- **needs-info:** reporter's next comment resumes the run with the added context.
- **PR review "changes requested"** → one more fix pass using the review comments.
- **Slack:** outbound via incoming webhook (escalations, S1/S2, PR ready). Inbound replies: Slack slash command → tiny relay → `repository_dispatch`. The relay can be a Cloudflare Worker free tier and is the one non-GitHub piece; if we want to stay strictly in GitHub, skip inbound and say "reply on the issue" in the Slack message. **Default: outbound only.**
- **Linear:** adapter interface + stub; out of scope for 48h.

---

## 8. Security

- Issue/comment text is wrapped as untrusted data, and the agent prompt states it is not instructions. Tool permissions never change based on issue content.
- The agent tools are scoped: file ops limited to the workspace, shell limited to the configured test/app commands plus a small allowlist, and network limited to `app.base_url`.
- Only `opened` from anyone, `retry/stop/hint` from collaborators; label `fixloop:skip` opts out.
- No production secrets in the runner, and the `GITHUB_TOKEN` gets least-privilege permissions.
- PR is a draft unless the gate passes; never merges.

---

## 9. Vikunja example (demo target)

- Use a local copy of Vikunja (no fork; the demo repo is uploaded later) → `examples/vikunja` config + `docker-compose.fixloop.yml` (api + frontend + postgres) + seed script.
- **Planted BE bug:** e.g. task filter `due_date < X` uses wrong comparison / off-by-one in pagination → Go test reproduces.
- **Planted FE bug:** e.g. marking task done in list view doesn't update the UI / wrong date formatting in task detail → Playwright reproduces.
- Optional third bug that should end as DIAGNOSIS_ONLY (touches auth path) to demo the risk gate and escalation.

---

## 10. Task breakdown (48h)

**Phase A — Foundations (H0–6)**
- [ ] A1 TS project, action.yml (node20, ncc bundle), vitest, lint
- [ ] A2 `.fixloop.yml` zod schema + loader
- [ ] A3 Local Vikunja copy with planted bugs, compose file booting in Actions, seed script, plant 2 bugs
- [ ] A4 Event router + guard + status comment skeleton (end-to-end "hello" on issue open)

**Phase B — Core agent (H6–20)**
- [ ] B0 `fixloop run --issue N [--dev|--stage|--dry-run]` local entry point (do first; speeds up everything after)
- [ ] B1 Agent client: Agent SDK, scoped tools, prompt caching, cost/budget tracker
- [ ] B2 Intake (Haiku): sanitize, dedupe, classify, severity, labels
- [ ] B3 Codebase brief generation + store on `fixloop-data`
- [ ] B4 Boot + log/trace collection
- [ ] B5 Reproduce stage: write failing test and verify red (BE first, then FE/Playwright)

**Phase C — Fix & deliver (H20–30)**
- [ ] C1 Fix loop with targeted + full test runs, Opus escalation, caps
- [ ] C2 Gate (unit-tested)
- [ ] C3 Deliver: branch, PR body, CODEOWNERS/blame reviewer, labels
- [ ] C4 needs-info + diagnosis-only paths

**Phase D — Memory & metrics (H30–36)**
- [ ] D1 Fix journal write + retrieval
- [ ] D2 Ledger + PR-closed outcome handler
- [ ] D3 Dashboard on Pages

**Phase E — HITL & polish (H36–40)**
- [ ] E1 Slack outbound notifier, severity-gated
- [ ] E2 Commands: retry/stop/hint/escalate; review-feedback pass
- [ ] E3 Linear stub adapter
- [ ] E4 `fixloop init` (stack detection, workflow, secrets, labels, data branch, smoke check); first to cut if short on time

**Phase F — Proof (H40–48)**
- [ ] F1 Replay evals on corpus; record metrics
- [ ] F2 Live demo: open BE bug → PR, open FE bug → PR (show journal reuse), risky bug → escalation
- [ ] F3 Video (5–10 min) + WRITEUP.md (built now / one-month roadmap)

---

## 11. "With a month" (write-up material)

- Bug detection: Sentry/Datadog alerts → issues, failing-main CI, synthetic monitors, log anomaly clustering
- Real o11y adapters (Datadog, Honeycomb, Grafana Tempo/Loki), prod-like data snapshots via DB branching
- Hosted GitHub App (multi-repo, org-wide memory, inbound Slack/Linear), with ephemeral preview envs instead of the runner
- Embedding-based retrieval over journal + code; learning from human edits to FixLoop PRs
- Progressive autonomy: per-area trust scores from merge/revert history unlock auto-merge for low-risk classes
- Larger eval corpus (SWE-bench-style) gating every prompt/model change
