# Veritone RPA

A Robotic Process Automation bot that pre-screens job applicants on behalf of **Strategy One HR** using the **Veritone Hire** (adcourier.com) applicant tracking system. Each night it logs in, applies keyword and location filters to every active advert within a configurable lookback window, flags non-passing candidates, reviews CVs via LLM, and emails a run summary report.

**Deployment:** GCP Compute Engine (e2-medium, Ubuntu 22.04 LTS), managed by pm2. Runs nightly between **7:00 PM and 10:00 PM Sydney time**, Sunday to Friday.

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | ^0.39.0 | Claude API for keyword selection and resume review |
| `dotenv` | ^16.4.5 | Loads environment variables from `.env` |
| `exceljs` | ^4.4.0 | Read/write `.xlsx` processing report |
| `luxon` | ^3.5.0 | Date parsing and timezone-aware comparisons |
| `node-cron` | ^3.0.3 | Schedules the nightly run at 7:00 PM Sydney time |
| `nodemailer` | ^6.9.15 | Sends run summary and error notification emails |
| `playwright` | ^1.50.0 | Chromium browser automation |
| `winston` | ^3.17.0 | Structured logging to console and rolling log file |

### Development

| Package | Version | Purpose |
|---|---|---|
| `typescript` | ^5.7.3 | Language |
| `tsx` | ^4.19.2 | Run TypeScript directly without a build step (`npm run dev`) |
| `@types/luxon` | ^3.4.2 | Type definitions for luxon |
| `@types/node` | ^22.0.0 | Type definitions for Node.js |
| `@types/node-cron` | ^3.0.11 | Type definitions for node-cron |
| `@types/nodemailer` | ^6.4.17 | Type definitions for nodemailer |

---

## Prerequisites

- **Node.js** v18 or later
- **npm** v9 or later
- A **Google account** with an [App Password](https://support.google.com/accounts/answer/185833) enabled for SMTP
- An **Anthropic API key** with access to Claude
- **Veritone Hire credentials** — passed via `VERITONE_USERNAME` and `VERITONE_PASSWORD`

---

## Setup

### 1. Clone and install

```bash
git clone <repository-url>
cd veritone-rpa
npm install
npx playwright install chromium
```

### 2. Configure environment variables

```bash
cp .env.template .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `RUN_MODE` | No | `production` (enforces 7PM–10PM window) or `testing` (skips window check); default: `production` |
| `LOOKBACK_DAYS` | No | How many days back to look for adverts; default: `30` |
| `EMAIL_USER` | Yes | Gmail address used to send notifications |
| `EMAIL_PASS` | Yes | Gmail App Password |
| `VERITONE_USERNAME` | Yes | Veritone Hire login username |
| `VERITONE_PASSWORD` | Yes | Veritone Hire login password |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | Service account email — same as the note-adding RPA |
| `GOOGLE_PRIVATE_KEY` | Yes | Service account private key (include `\n` line breaks) |
| `GOOGLE_SHEET_ID` | Yes | Google Sheet ID — same sheet as the note-adding RPA |

### 3. Build and run

**Development** (no build required):
```bash
npm run dev
```

**Production** (after building):
```bash
npm run build
npm start
```

---

## GCP Deployment

The bot runs on a GCP Compute Engine instance managed by pm2.

```bash
cd /home/ubuntu/veritone-rpa
npm install
npm run build
pm2 start dist/main.js --name "veritone-rpa"
pm2 save
pm2 startup
```

**Useful pm2 commands:**
```bash
pm2 logs veritone-rpa    # live logs
pm2 status               # process status
pm2 restart veritone-rpa # restart after code update
```

After pushing code changes, redeploy with:
```bash
git pull
npm run build
pm2 restart veritone-rpa
```

---

## Architecture

### Run Schedule

- **Trigger:** 7:00 PM Sydney time, Sunday–Friday (`0 19 * * 0-5`)
- **Run window:** 7:00 PM – 10:00 PM (hard stop enforced mid-run via `isWithinRunWindow()`)
- **Hard reset:** process exits after 3 hours regardless
- **Testing mode:** time window is not enforced — runs immediately on start

### Per-Advert Pipeline

1. **Filter** — enters keyword and location filter on the Responses page
2. **Collect** — paginates through all filtered candidates, captures fresh flag status
3. **Flag** — purple-flags candidates who did not pass the filter and have no existing flag
4. **Review** — opens each passing candidate's CV, checks screening note first (auto-flags if disqualifying answers), then calls Claude for LLM review

### Persistent State (`temp/`)

Two JSON files per advert are saved between runs to avoid re-processing:

- `passing-{advertId}.json` — filtered candidates with fresh flag status and bookmark ID
- `resume-review-{advertId}.json` — cumulative LLM review decisions and bookmark ID

These are automatically cleaned up for adverts no longer in the lookback window.

### Answered Questions Count

At the end of each run, the bot reads a `Summary` tab from the shared Google Sheet (written by the note-adding RPA). It matches by `refNumber|datePosted` and populates the **Answered questions** and **% answering questions** columns in the run summary email.

### Email Report

Sent at the end of every run to `sustdev3@gmail.com`, `bruce@8020green.com`, `simonm@s1hr.com.au`, and `suziew@s1hr.com.au`.

**Table columns:**

| Column | Description |
|---|---|
| Date | Advert posting date |
| Job Ref | Reference number |
| Job title | Job title |
| Location | Job location |
| Key words | Keywords applied to the filter |
| Total applicants | Total candidates on the advert |
| Number after location/keywords | Candidates passing keyword + location filter |
| Suitable (grey flags) | Candidates passing LLM resume review |
| Answered questions | Total form respondents for this advert (from Google Sheet) |
| % answering questions | Answered / total applicants |

A **Totals row** is appended at the bottom of the table.

### Error Handling

- **Fatal errors** (billing, quota, overloaded): run stops immediately, error email sent
- **Repeated errors** (same type ≥2 times): run stops, error email with full list sent
- **Screenshots** are captured on every error and included in the error email

---

## Safety Rules

These must not be violated:

1. Never overwrite an existing flag — only act on candidates with no flag
2. Never flag candidates who passed the filter
3. Always check for grey colour before writing any flag
4. Do not process adverts older than `LOOKBACK_DAYS`
