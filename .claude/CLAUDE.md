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

**Intended schedule:** nightly between 10 pm and 1 am Sydney time (AEST/AEDT), Sunday to Friday (not Saturday).
In `RUN_MODE=testing` the time-window check is not enforced.

**Language and core libraries:**

| Library | Purpose |
|---|---|
| TypeScript 5.7 / Node.js | Language and runtime |
| Playwright 1.50 | Browser automation (Chromium, headless with automated login) |
| `@anthropic-ai/sdk` 0.39 | LLM calls for keyword selection and resume review |
| ExcelJS 4.4 | Read/write `.xlsx` files |
| Luxon 3.5 | Date parsing and comparison |
| Winston 3.17 | Structured logging to console + rolling log file |
| node-cron 3.0 | Nightly scheduler — fires at 10:00 PM Sydney time, Sun–Fri (`0 22 * * 0-5`) |
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

**Note:** Excel writing is currently **disabled** via commented-out code in `src/adverts/advert-reader.ts` (lines that call `appendToExcel`). The output report functionality is handled entirely by email summaries. See §9 (Email Reports) below.

The schema is defined in `src/shared/excel-service.ts` as the `COL` constant for potential future re-enablement:

| Column | Index | Purpose |
|---|---|---|
| DATE_POSTED | 1 | Advert posting date (`dd/MM/yyyy`) |
| JOB_REF_NUMBER | 2 | Reference number from Veritone Hire |
| JOB_TITLE | 3 | Job title |
| LOCATION | 4 | Job location |
| KEYWORDS_USED | 5 | Keywords applied to filter (comma-separated) |
| TOTAL_APPLICATIONS | 6 | Total candidates on the advert |
| AFTER_KW_FILTER | 7 | Candidates passing keyword + location filter |
| PASSING_CANDIDATES | 8 | Candidates passing LLM resume review (unflagged count) |

Row 1 is assumed to be a header row. If re-enabled, one row is appended per advert processed.

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

## 8. PERSISTENT RUN STATE & BOOKMARK ARCHITECTURE

The bot persists state in two files per advert to support efficient pagination and avoid
re-processing candidates across runs:

### File 1: `temp/passing-{advertId}.json`

Saved by `collectPassingCandidates()` after candidate collection.

```json
{
  "advertId": "12345",
  "collectedAt": "2026-04-10T19:30:00.000Z",
  "totalFiltered": 42,
  "selectedKeywords": "plumbing",
  "lastProcessedId": "cand-001",
  "passingCandidates": [...]
}
```

**Fields:**
- `passingCandidates` — all candidates who passed keyword + location filter, with fresh flag
  status from tonight's scrape (not from previous JSON). This includes:
  - New candidates found this run (not seen before)
  - Existing candidates from previous run, re-scraped with current flag status
  
  **Why both?** HR may manually flag a candidate between runs. Re-scraping ensures the email
  report shows the correct current flag status.

- `lastProcessedId` — the first candidate ID seen on page 1 of the filtered list. Passed to
  `flagFailingCandidates()` as the pagination bookmark.

- `totalFiltered` — count of candidates passing keyword + location filter (used to determine
  strict vs standard LLM ruleset)

### File 2: `temp/resume-review-{advertId}.json`

Saved by `reviewResumes()` after LLM review. Contains cumulative state across runs.

```json
{
  "advertId": "12345",
  "reviewedAt": "2026-04-10T19:45:00.000Z",
  "totalReviewed": 38,
  "ruleset": "standard",
  "selectedKeywords": "plumbing",
  "lastProcessedId": "cand-001",
  "results": [...]
}
```

**Fields:**
- `results` — every candidate review ever recorded for this advert (new + previous). Each record:
  ```json
  {
    "id": "cand-123",
    "name": "John Doe",
    "ai_decision": "pass" | "fail",
    "ai_reason": "Strong 10+ years experience",
    "rejection_category": "general" | null,
    "defaulted": true | undefined
  }
  ```
  Records persist forever. When writing the file, previous results are kept as-is and only
  new candidate records are appended.

- `lastProcessedId` — the first candidate ID seen on page 1 after navigation to adcresponses.
  Becomes the pagination bookmark for the next run's reviewer.

- `selectedKeywords` — the keyword(s) selected for this advert's filter (from LLM or reused
  from previous run).

### Bookmark-Based Pagination Strategy

The bot uses bookmarks to stop pagination when re-processing candidates:

#### Candidate Collection (`candidate-collector.ts`)
**Bookmark:** None — full re-scrape every run
- Paginates through all filtered candidates
- Captures fresh flag status for all candidates (to detect manual HR flags)
- Records `newLastProcessedId` from page 1

**Rationale:** Ensures accurate flag detection across runs.

#### Candidate Flagging (`candidate-flagger.ts`)
**Bookmark:** `previousLastProcessedId` (from collector, passed as parameter)
- Uses bookmark to stop pagination when the ID is reached
- Only flags candidates above the bookmark (newly seen)
- Falls back: if bookmark not found after 3 empty pages, continues pagination

**Rationale:** Most candidates haven't changed. Skipping already-flagged candidates saves
browser interactions.

#### Resume Review (`resume-reviewer.ts`)
**Bookmark:** `existingLastProcessedId` (from previous run's `resume-review-{advertId}.json`)
- Uses bookmark to stop pagination when the ID is reached
- **Skips LLM calls** for candidates in `previouslyPassedIds` (those with `ai_decision: "pass"`)
- Falls back: if bookmark not found after 3 empty pages, continues pagination

**Rationale:** LLM calls are expensive. Skipping already-reviewed candidates minimizes API cost.
The bookmark ensures candidates above it (newly seen) are reviewed; those below are marked
as "pass" without re-opening their modal.

### Keyword Reuse (`candidate-filter.ts`)

At the start of `filterCandidates()`, the bot checks for an existing
`temp/resume-review-{advertId}.json`. If found and `selectedKeywords` is non-empty, the
LLM call is skipped entirely and those keywords are reused. Logs:
`[CandidateFilter] Reusing keywords from previous run: ...`

**Rationale:** Keyword selection is deterministic — reusing them saves an LLM call.

### Resume Review Skip

At the start of `reviewResumes()`, previously passed candidates (where `ai_decision === "pass"`
in the existing file) are loaded into `previouslyPassedIds`. Any candidate in this set is
skipped without opening their modal or calling the LLM.

Previously defaulted-to-pass candidates (where `defaulted === true` in the existing file) are
also counted into `defaultedToPassCount` at load time so the tally carries forward across runs.

### Stale File Cleanup (`advert-reader.ts`)

After `filterAndSort()` produces the run's advert list, both state files in `temp/` whose
advert ID is not in the current run are deleted. Logs:
`[AdvertReader] Deleted stale state file for advert {advertId} — not in current run`

---

## 9. EMAIL REPORTS

At the end of each run, the bot sends a summary email via `sendRunSummaryEmail()` in
`src/shared/email-service.ts`. Excel output is disabled (code is commented out).

### Email Recipients

Hardcoded in `src/shared/email-service.ts` (lines 65–70):
- `sustdev3@gmail.com`
- `bruce@8020green.com`
- `simonm@s1hr.com.au` (optional, see below)
- `suziew@s1hr.com.au` (optional, see below)

To change recipients, edit the `to` array in `sendRunSummaryEmail()`.

### Email Content

Generated by `buildRunSummaryHtml()` in `src/templates/run-summary-email.ts`.

**Summary metrics:**
- Total adverts processed, skipped, and errored
- Timestamp (Sydney time: `dd/MM/yyyy HH:mm`)

**Per-advert table:**
Each row contains:
- Job title and reference number
- Date posted
- Location
- Keywords applied
- Candidates passing keyword filter
- **Passing candidates** (unflagged count after resume review)
  - Calculated as: `reviewResult.passCount + collectResult.existingUnflaggedCount`
  - Ensures manual HR flags are reflected in the count
- Rejection categories (count of LLM fails by category)
- Elapsed time for the advert
- Status (success / skipped / error)

### Error Emails

On fatal or repeated errors, the bot sends an additional email via `sendErrorReportEmail()` with:
- Error type and message
- Advert title
- Screenshot path (if captured)

---
