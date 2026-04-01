# Veritone RPA — Project Reference

## 1. PROJECT OVERVIEW

This is a Robotic Process Automation (RPA) bot that pre-screens job applicants on behalf of
**Strategy One HR**, a recruitment agency that uses **Veritone Hire** (adcourier.com) as its
applicant tracking system.

Each night the bot logs in to Veritone Hire, reads every advert posted within a configurable
lookback window, and for each advert:
1. Enters keyword and location filters on the Responses page
2. Collects the IDs of candidates who passed the filter
3. Flags (purple) candidates who did not pass the filter and have no existing flag
4. Reviews CVs of passing candidates via LLM and records pass/fail decisions
5. Writes a row to a Processing Report spreadsheet

**Intended schedule:** nightly between 7 pm and 7 am Sydney time (AEST/AEDT).
In `RUN_MODE=testing` the time-window check is not enforced.

**Language and core libraries:**

| Library | Purpose |
|---|---|
| TypeScript 5.7 / Node.js | Language and runtime |
| Playwright 1.50 | Browser automation (Chromium, headful) |
| `@anthropic-ai/sdk` 0.39 | LLM calls for keyword selection and resume review |
| ExcelJS 4.4 | Read/write `.xlsx` files |
| Luxon 3.5 | Date parsing and comparison |
| Winston 3.17 | Structured logging to console + rolling log file |
| node-cron 3.0 | Nightly scheduler — fires at 7:00 PM Sydney time (`0 19 * * *`) |
| nodemailer 6.9 | Fault email notifications (fatal + repeated errors) |
| dotenv 16 | Loads `.env` at startup |
| tsx 4.19 | Dev runner (`npm run dev`) |

---

## 2. FOLDER STRUCTURE

```
veritone-rpa/
├── src/
│   ├── main.ts                   Entry point — orchestrates the full run
│   ├── browser-session.ts        Launches Chromium; auto-logs in via VERITONE_USERNAME /
│   │                             VERITONE_PASSWORD env vars (falls back to manual login if unset);
│   │                             exports setActivePage / getActivePage for crash handler access
│   ├── activity-logger.ts        Winston logger instance (console + rolling file) — not yet wired in
│   ├── adverts/
│   │   ├── advert-reader.ts      Playwright steps: reads advert rows, drives per-advert loop
│   │   ├── advert-page-object.ts All advert logic and types: AdvertSummary, AdvertDetail,
│   │   │                         RawAdvertRow, DEFAULT_LOOKBACK_DAYS, isFatalError,
│   │   │                         classifyError, parseAdvertRow, filterAndSort
│   │   └── page-navigation.ts    Navigates to Manage Adverts (and archived tab)
│   ├── candidates/
│   │   ├── candidate-filter.ts   Playwright steps: enters keywords/location/distance, clicks search
│   │   ├── candidate-collector.ts Playwright steps: paginates filtered responses, collects cards
│   │   ├── candidate-flagger.ts  Playwright steps: reads flag state, clicks purple flag
│   │   └── candidate-page-object.ts All candidate logic and types: PassingCandidate, FilterResult,
│   │                              CollectResult, FlagResult, CardData, NonPassingNoFlag,
│   │                              NonPassingAlreadyFlagged, FLAG_COLOUR_MAP, classifyCards,
│   │                              buildCollectSummary, selectKeywordsViaLLM
│   ├── resume/
│   │   ├── resume-reviewer.ts    Playwright steps: paginates, opens CV modal, extracts text,
│   │   │                         calls LLM, flags failed candidates
│   │   └── resume-page-object.ts All resume logic and types: ReviewResult, ReviewSummary,
│   │                              validRejectionCategories, RejectionCategory,
│   │                              validateLlmResponse, tallyRejectionCounts
│   ├── shared/
│   │   ├── utils.ts              randomDelay, cleanupSession, parseAdvertDate, takeScreenshot
│   │   ├── excel-service.ts      appendToExcel, markAdvertSkipped, finaliseAdvertRow,
│   │   │                         writeAdvertError; COL column-index map
│   │   ├── llm-service.ts        callLLM; loadLLMSelections; loadCommonKeywords; loadAllVariables
│   │   └── email-service.ts      sendRunSummaryEmail; sendErrorReportEmail; AdvertRunResult
│   └── prompts/
│       ├── identify-keywords.ts  buildKeywordPrompt() — keyword selection prompt
│       └── review-resume.ts      buildReviewPrompt() — resume review prompt
│
├── data/
│   ├── Processing-Report.xlsx    Output report — one row written per advert processed
│   ├── Variables-used-by-LLMs.xlsx  LLM model selection + common keywords (see §6)
│   └── rejection-filters.md      Reference doc — rejection criteria (not used by code yet)
│
├── config/
│   └── rejection-filters.md      Rejection criteria — loaded at runtime by resume-reviewer.ts
│
├── logs/
│   └── rpa.log                   Rolling log — 5 MB max, 7 files retained
│
├── screenshots/                  Full-page screenshots captured on error — never committed
│
├── temp/                         Scratch space — excluded from tsc compilation
│   ├── passing-{advertId}.json   Passing candidates collected after keyword filter
│   └── resume-review-{advertId}.json  LLM resume review results + selectedKeywords
│                                       (used for persistent run state — see §10)
│
├── .env                          Live secrets — never commit
├── .env.template                 Template showing all required variables
├── tsconfig.json                 Target ES2022, strict, outDir ./dist
└── package.json                  Scripts: dev (tsx), build (tsc), start (node dist/)
```

---

## 3. SAFETY RULES

These rules protect candidates and the integrity of the Veritone Hire data.
They must not be violated.

1. **Never overwrite an existing flag.** If a candidate already has a flag (any colour),
   do not change it. Only act on candidates that have no flag.
2. **Never flag candidates who passed the filter.** Flagging (rejection) applies only to
   candidates who did not survive the keyword + location search.
3. **Always check for grey colour before flagging.** The expected state of an un-actioned
   candidate is grey (no flag). Confirm this visually/via selector before writing any flag.
4. **The lookback rule is enforced by `LOOKBACK_DAYS`.** Do not process adverts
   older than the configured window. Production default is 30 days.
5. **Archived adverts are used for testing only.** The live run always operates on the
   default (non-archived) Manage Adverts view. Archived navigation is a testing override
   and must be removed before going live.

---

## 4. EXCEL FILES

### `data/Processing-Report.xlsx`

One row is appended per advert processed. Column indices are defined in
`src/shared/excel-service.ts` as the `COL` constant.

The initial row write (`appendToExcel`) writes START_TIME through AFTER_KW_FILTER.
Subsequent writes update the same row via `finaliseAdvertRow` (on success),
`markAdvertSkipped` (zero filtered candidates), or `writeAdvertError` (on error).

| Column | Index | Written? |
|---|---|---|
| START_TIME | 1 | Yes — `dd/MM/yyyy HH:mm:ss` |
| END_TIME | 2 | Yes — ISO timestamp (Sydney time); `"SKIPPED (NO FILTERED CANDIDATES)"` if zero results |
| ELAPSED | 3 | Yes — `"X.X mins"`; `"SKIPPED (NO FILTERED CANDIDATES)"` if zero results |
| JOB_TITLE | 4 | Yes |
| LOCATION | 5 | Yes |
| JOB_DESCRIPTION | 6 | Yes |
| TOTAL_APPLICATIONS | 7 | Yes |
| KEYWORD_1 | 8 | Yes |
| KEYWORD_2 | 9 | Yes |
| KEYWORD_3 | 10 | Yes |
| KEYWORD_4 | 11 | Yes |
| AFTER_KW_FILTER | 12 | Yes — filtered candidate count |
| AFTER_RESUME | 13 | Yes — LLM pass count after resume review |
| ERROR | 14 | Yes — `"no errors"` on success; error message on failure |
| GENERAL_FILTER_REJECTS | 15 | Yes — LLM fails with `rejection_category = "general"` |
| LABOURING_FILTER_REJECTS | 16 | Yes — LLM fails with `rejection_category = "labouring"` |
| HEAVY_LABOURING_REJECTS | 17 | Yes — LLM fails with `rejection_category = "heavy_labouring"` |
| EMPLOYMENT_DATE_REJECTS | 18 | Yes — LLM fails with `rejection_category = "employment_date"` |

Row 1 is assumed to be a header row. The service scans down from row 2 to find the first
empty `JOB_TITLE` cell and writes there.

### `data/Variables-used-by-LLMs.xlsx`

Two sheets:

| Sheet | Contents |
|---|---|
| `LLM-selection` | Col 1: task name (lowercase), Col 2: model name (`haiku` / `sonnet` / `opus`) |
| `Common-keywords` | Col 1: one keyword per row (lowercased on load) |

The `LLM-selection` sheet maps task names to Claude model IDs via `MODEL_MAP` in
`llm-service.ts`. Unrecognised model names fall back to `claude-haiku-4-5-20251001`.

Current task names in the sheet: `identify keywords`, `resume review`.

---

## 5. ENVIRONMENT VARIABLES

Copy `.env.template` to `.env` and fill in real values. Never commit `.env`.

| Variable | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Claude API key (required) |
| `RUN_MODE` | `production` | `production` enforces 7 pm–7 am window; `testing` skips it |
| `LOOKBACK_DAYS` | `30` | How many days back to look for adverts (production) |
| `EMAIL_USER` | — | Gmail address used to send notifications |
| `EMAIL_PASS` | — | Gmail App Password for the sending account |
| `VERITONE_USERNAME` | — | Veritone Hire login username (optional — falls back to manual login if not set) |
| `VERITONE_PASSWORD` | — | Veritone Hire login password (optional — falls back to manual login if not set) |

**Email recipients** are hardcoded in `email-service.ts`: `sustdev3@gmail.com` and `bruce@8020green.com`. They are not read from `.env`.

**Currently:** `RUN_MODE=production` and `LOOKBACK_DAYS=30`.

---

## 6. TESTING VS PRODUCTION

### The distinction

**Production** reads every advert posted within the last 30 days from the live Manage Adverts
page and runs the full pipeline on each one, processing all eligible adverts per run.

**Archived testing** (previous approach — now removed) ran against 5 handpicked adverts from
page 10 of the Archived Adverts tab. All archived testing overrides have been removed from the
codebase.

### Current state

The bot is now running in full production mode. All `// TESTING ONLY` overrides have been removed:

- The 20-day minimum age ceiling filter has been removed from `filterAndSort` — all adverts within the 30-day lookback window are now processed.
- The `.slice(0, 10)` advert cap has been removed — all eligible adverts are processed per run.

There are **no** remaining `// TESTING ONLY` blocks in the codebase.

---

## 7. ERROR HANDLING

### Fatal errors — immediate stop

`isFatalError()` in `advert-page-object.ts` matches these strings (case-insensitive) in the
error message and triggers an immediate halt:

- `"credit balance is too low"`
- `"insufficient_quota"`
- `"billing"`
- `"overloaded_error"` — Anthropic API 529 after all retries exhausted

On a fatal error the bot: writes the error to `COL.ERROR` in the report via `writeAdvertError()`,
sends a `"RPA STOPPED — fatal error"` email, and exits the advert loop immediately.

### Repeated errors — graceful stop

Non-fatal errors are classified by type (`timeout`, `selector`, `navigation`, `other`) via
`classifyError()` in `advert-page-object.ts` and counted. If the same error type occurs
**2 or more times**, the bot stops and sends a `"RPA STOPPED — repeated {type} error"` email
listing all errors encountered.

### Screenshot capture on error

`takeScreenshot(page, label)` in `src/shared/utils.ts` captures a full-page screenshot whenever
an error occurs. It is always wrapped in try/catch and never throws — if the browser is already
closed the failure is logged as a warning and `null` is returned.

Screenshots are saved to `screenshots/{label}-{timestamp}.png` (e.g.
`screenshots/error-advert-519344-2026-03-23T19-34-48.png`) and the path is:
- Logged to console: `[Utils] Screenshot saved: {path}`
- Appended to the per-advert error log line in `advert-reader.ts`
- Included in the body of `sendErrorReportEmail()` when a path is available

Trigger points:
| Trigger | Label |
|---|---|
| Per-advert catch block (fatal or non-fatal) | `error-advert-{advertId}` |
| Repeated-error stop (before email) | same screenshot taken at catch entry |
| `uncaughtException` / `unhandledRejection` in `main.ts` | `fatal-crash` |

The `screenshots/` folder is in `.gitignore` and is never committed.

### LLM retry logic (`llm-service.ts`)

| Error type | HTTP status | Retries | Backoff |
|---|---|---|---|
| Rate limit | 429 | Up to 3 | 1 s, 2 s, 4 s |
| Overloaded | 529 | Up to 3 | 15 s, 30 s, 60 s |

After retries are exhausted the original error is re-thrown. An `overloaded_error` that
survives all retries is caught by `isFatalError` and stops the run.

---

## 8. PERSISTENT RUN STATE

The bot persists state in `temp/resume-review-{advertId}.json` to make re-runs efficient
after an interrupted or partial run.

### What is saved

Each file stores:
- `selectedKeywords` — the keywords chosen by the LLM for this advert's filter
- `results` — every candidate review record (`id`, `name`, `ai_decision`, `ai_reason`,
  `rejection_category`, `defaulted?`) — `defaulted: true` is set when the LLM response
  could not be parsed and the candidate was automatically passed
- `advertId`, `reviewedAt`, `totalReviewed`, `ruleset`

### Keyword reuse (`candidate-filter.ts`)

At the start of `filterCandidates()`, the bot checks for an existing
`temp/resume-review-{advertId}.json`. If found and `selectedKeywords` is non-empty, the
LLM call is skipped entirely and those keywords are reused. Logs:
`[CandidateFilter] Reusing keywords from previous run: ...`

### Resume review skip (`resume-reviewer.ts`)

At the start of `reviewResumes()`, previously passed candidates (where `ai_decision === "pass"`
in the existing file) are loaded into `previouslyPassedIds`. Any candidate in this set is
skipped without opening their modal or calling the LLM. The count is reported in
`ReviewSummary.skippedPreviouslyPassed` and logged in the advert-reader summary line.

Previously defaulted-to-pass candidates (where `defaulted === true` in the existing file) are
also counted into `defaultedToPassCount` at load time so the tally carries forward across runs.

When writing the output file, new results are merged with the previous results — previous
records are kept as-is and only new candidate records are appended.

### Stale file cleanup (`advert-reader.ts`)

After `filterAndSort()` produces the run's advert list, both `resume-review-{advertId}.json`
and `passing-{advertId}.json` files in `temp/` whose advert ID is not in the current run are
deleted. Logs: `[AdvertReader] Deleted stale state file for advert {advertId} — not in current run`

---
