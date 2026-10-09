# FixLoop

FixLoop turns GitHub bug reports into tested pull requests. It runs an agent in GitHub Actions to triage an issue, reproduce the bug with a failing test, attempt a fix, and decide whether to open a PR or post a diagnosis. You can also run the same pipeline locally.

Every run updates a status comment on the issue. Generated fixes go through test and risk checks, and pull requests stay available for human review; FixLoop does not merge them.

## How it works

```text
Issue → Intake → Context → Boot → Reproduce → Fix → Gate → Deliver → Notify
```

1. **Intake** assesses the report and looks for duplicates or missing information.
2. **Context** reads the repository and builds a cached codebase brief.
3. **Boot** starts the app, waits for it to become healthy, and optionally seeds test data.
4. **Reproduce** writes and runs a regression test in a scratch checkout. An assertion failure must demonstrate the bug; a broken test or missing dependency does not count.
5. **Fix** changes the code until the regression test and configured full suite pass.
6. **Gate** scores the evidence and checks sensitive paths and diff size.
7. **Deliver / Notify** opens or updates a ready or draft PR, or posts a diagnosis when no fix qualifies. Optional Slack messages report escalations and ready PRs.

The current test runners support **Go backend tests, Vitest frontend tests, and Playwright browser tests**. Frontend preparation uses pnpm. Commands are configurable, but test generation and failure classification are specific to these tools.

## Set up GitHub Actions

Add a `.fixloop.yml` to the root of the repository you want FixLoop to fix, then add `ANTHROPIC_API_KEY` as a repository Actions secret.

Create `.github/workflows/fixloop.yml`:

```yaml
name: FixLoop

on:
  issues:
    types: [opened]
  issue_comment:
    types: [created]

permissions:
  contents: write
  issues: write
  pull-requests: write
  actions: write

jobs:
  stop:
    if: >-
      github.event_name == 'issue_comment' &&
      !github.event.issue.pull_request &&
      contains(github.event.comment.body, '/fixloop stop')
    runs-on: ubuntu-latest
    steps:
      - uses: Amiram1/fix-loop@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

  fixloop:
    if: >-
      github.event_name == 'issues' ||
      (github.event_name == 'issue_comment' &&
      !github.event.issue.pull_request &&
      !contains(github.event.comment.body, '/fixloop stop') &&
      (contains(github.event.comment.body, '/fixloop') ||
      (contains(github.event.issue.labels.*.name, 'needs-info') &&
      github.event.comment.user.login == github.event.issue.user.login)))
    runs-on: ubuntu-latest
    timeout-minutes: 60
    concurrency:
      group: fixloop-${{ github.event.issue.number }}
      cancel-in-progress: false
    steps:
      - uses: actions/checkout@v5
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 0
          persist-credentials: false

      # Install your app's toolchain and test dependencies here.

      - uses: Amiram1/fix-loop@main
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The separate stop job lets cancellation run immediately instead of queuing behind the active run. Commands are also checked by FixLoop for trusted authors.

Install the target app's tools before invoking the Action: Go for backend tests, Node and pnpm for frontend tests, Docker for a Compose app, and browser system dependencies for Playwright. Enable the repository setting that allows GitHub Actions to create pull requests. For reproducible deployments, replace `@main` with a reviewed commit SHA.

The [Vikunja workflow](examples/vikunja/fixloop.workflow.yml) is a fuller example with toolchain setup, caches, review feedback, and PR outcome tracking. Its [configuration](examples/vikunja/.fixloop.yml), [Compose stack](examples/vikunja/docker-compose.fixloop.yml), and [seed script](examples/vikunja/scripts/fixloop-seed.sh) show a complete app integration.

## Configure the target repository

Create `.fixloop.yml` manually. This example assumes a Go backend, a pnpm frontend under `frontend/`, and a Docker Compose app; adapt the paths and commands to your project:

```yaml
app:
  up: docker compose up -d --build --wait
  down: docker compose down
  base_url: http://localhost:3000
  health_timeout_s: 120
  # seed: ./scripts/seed-test-data.sh

logs:
  - type: docker
    services: [api]
  # - type: file
  #   path: ./logs/app.log

tests:
  backend:
    run: go test ./{{dir}} -run ^{{name}}$
    dir: .
    new_test_glob: "pkg/**/*_test.go"
  frontend:
    run: pnpm vitest run {{file}}
    dir: frontend
    new_test_glob: "frontend/src/**/*.test.ts"
  e2e:
    run: pnpm exec playwright test {{file}} -g {{name}} --reporter=list --retries=0
    dir: frontend
    new_test_glob: "frontend/tests/e2e/fixloop/*.spec.ts"
  full: "go test ./pkg/... && (cd frontend && pnpm test:unit --run)"

areas:
  backend: ["pkg/**", "*.go"]
  frontend: ["frontend/src/**"]

risk:
  high_paths: ["pkg/auth/**", "pkg/migrations/**"]
  max_diff_lines: 150

budget:
  per_run_usd: 1.5
  max_fix_iterations: 4

autonomy:
  ready_pr_min_confidence: 0.8
  draft_pr_min_confidence: 0.5
```

`app.up`, `app.base_url`, and `tests.full` are required. Configure at least one supported test runner for reproduction; remove test blocks your project does not use.

- `dir` is the working directory for the test command. `new_test_glob` is relative to the repository root and limits where generated tests may be created.
- `{{file}}`, `{{dir}}`, and `{{name}}` are substituted with the test file, its containing directory, and test name. Frontend file paths are made relative to the configured working directory.
- Playwright receives the running app's address as `BASE_URL`. Optional `tests.e2e.env` supplies non-secret test values, such as credentials for a disposable seeded user.
- `app.down` is optional, but configure it so FixLoop can clean up services after a run. Use disposable test data, especially if teardown removes volumes.
- File traces can be configured with `traces: { type: otel-file, path: ./traces.jsonl }`.

Model IDs and reasoning effort can be overridden with `models` (`triage`, `fix`, `escalate`) and `effort` (`triage`, `reproduce`, `fix`, `escalate`). See the [configuration schema](src/config/schema.ts) for the exact defaults and all supported fields.

The gate requires both the target test and the full suite to pass before allowing a PR. High-risk paths, corroborated S1 severity, or a diff over the size limit force an otherwise qualifying change into a draft. Below the confidence threshold, FixLoop posts a diagnosis.

The spend limit is checked before each model request. A request already in progress can take the total over the limit; the setting is not an exact billing cap.

## Control a run

Owners, members, and collaborators can comment on an issue:

| Comment | Effect |
| --- | --- |
| `/fixloop retry` | Start another attempt. |
| `/fixloop hint The failure happens after logout` | Start another attempt with additional context. |
| `/fixloop escalate` | Use the configured escalation model and effort for the fix stage. |
| `/fixloop stop` | Cancel the run linked from the issue's status comment. |

Add the `fixloop:skip` label to prevent runs on an issue. If FixLoop asks for more information and adds `needs-info`, a reply from the original reporter resumes the pipeline.

With the review event enabled in the full workflow, a trusted maintainer's **changes requested** review triggers another fix pass on the existing `fixloop/issue-<number>` branch, reusing the recorded regression test.

## Run locally

Build FixLoop from source with Node.js 24 or newer:

```sh
git clone https://github.com/Amiram1/fix-loop.git
cd fix-loop
npm install
npm run build
node dist/cli.js --help
```

Then run from the **target repository**, which should contain `.fixloop.yml` and the app's required toolchain:

```sh
export ANTHROPIC_API_KEY=your-api-key
export GITHUB_TOKEN=your-github-token

node /absolute/path/to/fix-loop/dist/cli.js run --issue 123 --dev --dry-run
```

The CLI also loads `.env` from the current directory; existing environment variables take precedence. Keep it out of version control. If `GITHUB_TOKEN` is absent, it tries `gh auth token`. The repository is inferred from `GITHUB_REPOSITORY`, then the origin remote, or can be supplied with `--repo owner/name`.

| Option | Effect |
| --- | --- |
| `--config path/to/.fixloop.yml` | Use another config; its directory becomes the target repository root. |
| `--dev` | Use the development Haiku model at low effort for all model stages. |
| `--dry-run` | Print status, proposed changes, and delivery details instead of writing to GitHub or Slack. |
| `--stage Intake` | Run one named stage; other stages are skipped. |

A dry run still reads GitHub, calls paid models, starts the app, executes tests, and records local run data. Later stages need artifacts from earlier stages, so `--stage` is mainly useful for inspecting independent stages such as Intake or Context.

Check the model connection with `node /absolute/path/to/fix-loop/dist/cli.js ping`, optionally passing `--model <id>`. This makes a paid API request.

## Memory, metrics, and notifications

Action runs store cached briefs, journal entries, the run ledger, and `dashboard.md` on the target repository's `fixloop-data` branch. Local runs store data under `.fixloop/data/` in the target repository. Journal entries let future attempts reuse earlier findings.

From the target repository:

```sh
node /absolute/path/to/fix-loop/dist/cli.js metrics --local
node /absolute/path/to/fix-loop/dist/cli.js metrics --repo owner/name
node /absolute/path/to/fix-loop/dist/cli.js metrics --repo owner/name --markdown
```

The full example workflow records merged, closed, and reverted PR outcomes. To enable Slack, pass a webhook through the Action's `slack-webhook` input (or `SLACK_WEBHOOK` locally) and configure:

```yaml
notify:
  slack:
    min_severity: S2
    on: [escalation, pr_ready]
```

## Development

```sh
npm test
npm run typecheck
npm run lint
npm run build
```

Some integration tests require Docker, browsers, or live API credentials; inspect the relevant test's environment requirements before enabling them.

The TypeScript code is organized around `src/pipeline/` stages, `src/repro/` test runners, `src/fix/` repair loops, and `src/gate/` delivery checks. GitHub integration lives in `src/adapters/` and `src/deliver/`; memory and reporting live in `src/memory/`, `src/data/`, and `src/metrics/`.

FixLoop executes repository commands and generated tests. Use an isolated runner and disposable app data, and review generated PRs before merging. Child commands receive an allowlisted environment, but that is not a full execution sandbox.
