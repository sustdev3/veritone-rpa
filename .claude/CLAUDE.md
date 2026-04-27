# Veritone RPA — Developer Guide

## How to Run

**Development (no build needed):**
```bash
npm run dev
```
Set `RUN_MODE=testing` in `.env` — skips the 7PM–10PM time window and runs immediately.

**Production:**
```bash
npm run build
npm start
# or via pm2:
pm2 restart veritone-rpa
```

**After pushing changes to GCP:**
```bash
git pull && npm run build && pm2 restart veritone-rpa
```

---

## Environment Variables

Copy `.env.template` to `.env`. Key variables:

| Variable | Notes |
|---|---|
| `RUN_MODE` | `testing` skips time window; `production` enforces 7PM–10PM Sydney time |
| `LOOKBACK_DAYS` | How many days back to look for adverts (default: 30) |
| `ANTHROPIC_API_KEY` | Claude API key |
| `VERITONE_USERNAME` / `VERITONE_PASSWORD` | Veritone Hire credentials |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` / `GOOGLE_PRIVATE_KEY` / `GOOGLE_SHEET_ID` | Same sheet as note-adding RPA |
| `EMAIL_USER` / `EMAIL_PASS` | Gmail App Password for notifications |

Never commit `.env`.

---

## Project Structure

```
src/
├── main.ts                    Entry point — orchestrates the full run
├── adverts/
│   ├── advert-reader.ts       Drives the per-advert loop; sends summary email
│   ├── advert-page-object.ts  Types, parsing, filtering logic
│   └── page-navigation.ts     Navigates to Manage Adverts
├── candidates/
│   ├── candidate-filter.ts    Enters keyword/location filters
│   ├── candidate-collector.ts Paginates filtered candidates, saves passing-{id}.json
│   ├── candidate-flagger.ts   Purple-flags non-passing candidates
│   ├── candidate-page-object.ts Types and logic for candidate cards
│   └── questionnaire-screener.ts Parses screening notes; determines auto-purple-flag
├── resume/
│   ├── resume-reviewer.ts     Opens CV modal, checks screening note, calls LLM
│   └── resume-page-object.ts  Types and logic for resume review
├── services/
│   └── questionnaire-sheet.ts Reads Summary tab → Map<"adrefNo|datePosted", count>
├── shared/
│   ├── email-service.ts       sendRunSummaryEmail, sendErrorReportEmail
│   ├── llm-service.ts         Claude API calls with retry logic
│   ├── utils.ts               randomDelay, takeScreenshot, cleanupSession
│   └── excel-service.ts       Excel helpers (currently disabled/commented out)
├── templates/
│   └── run-summary-email.ts  Builds the HTML run summary email
└── prompts/
    ├── identify-keywords.ts   Keyword selection prompt
    └── review-resume.ts       Resume review prompt
```

---

## Key Coding Practices

### Safety rules — never break these
1. Never overwrite an existing flag — only flag candidates with no flag
2. Never flag candidates who passed the filter
3. Always check for grey colour before writing any flag

### State files (`temp/`)
- `passing-{advertId}.json` — filtered candidates + bookmark ID for the flagger
- `resume-review-{advertId}.json` — cumulative LLM decisions + bookmark ID for the reviewer
- These persist between runs to avoid re-processing. Stale files are cleaned up automatically.

### Run window
- Schedule: `0 19 * * 0-5` (7PM Sydney, Sun–Fri)
- Window guard in `main.ts`: skips if `h < 19 || h >= 22`
- Mid-run check in `advert-reader.ts` (`isWithinRunWindow()`): stops between adverts if `!(h >= 19 && h < 22)`
- Both must be updated together if the window changes

### Email report (`run-summary-email.ts`)
- 10 columns: Date, Job Ref, Job title, Location, Key words, Total applicants, Number after location/keywords, Suitable (grey flags), Answered questions, % answering questions
- Answered questions count comes from the Summary tab of the shared Google Sheet (written by the note-adding RPA), matched by `refNumber|datePosted`
- Totals row is appended at the bottom

### LLM calls
- Model selection is driven by `data/Variables-used-by-LLMs.xlsx` — do not hardcode model names
- Retry logic is in `llm-service.ts` (429 → 3 retries; 529 → 3 retries with longer backoff)
- Fatal errors (`billing`, `quota`, `overloaded_error` after retries) stop the run immediately

### Error handling
- Per-advert errors are counted by type — same type ≥2 times stops the run
- Screenshots are captured on every error via `takeScreenshot()` and attached to error emails
- `uncaughtException` and `unhandledRejection` are both handled in `main.ts`

### Adding new fields to the email
- Add the field to `AdvertRunResult` in `email-service.ts`
- Populate it in `advert-reader.ts` where `runResults.push(...)` is called
- Render it in `run-summary-email.ts` (update both the header row and data row)
- Update the totals row in `run-summary-email.ts` if the field is numeric
