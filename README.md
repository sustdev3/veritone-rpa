# Veritone RPA

A Robotic Process Automation bot that pre-screens job applicants on behalf of **Strategy One HR** using the **Veritone Hire** (adcourier.com) applicant tracking system. Each night it logs in to Veritone Hire, applies keyword and location filters to every active advert within a configurable lookback window, flags non-passing candidates, reviews CVs via LLM, and emails a run summary report.

**Deployment:** The bot runs on a Google Cloud Platform (GCP) Compute Engine instance (e2-medium, Ubuntu 22.04 LTS) with automatic restart on crash via pm2, and is scheduled to run nightly between 7:00 PM and 7:00 AM Sydney time (AEST/AEDT).

**Key Optimization:** Uses bookmark-based pagination to avoid re-processing candidates across runs. The collector re-scrapes all filtered candidates nightly (for fresh flag status), while the flagger and resume reviewer use bookmarks to skip already-processed candidates and minimize LLM calls.

---

## Dependencies

### Runtime

| Package | Version | Purpose |
|---|---|---|
| `@anthropic-ai/sdk` | ^0.39.0 | Claude API calls for keyword selection and resume review |
| `dotenv` | ^16.4.5 | Loads environment variables from `.env` at startup |
| `exceljs` | ^4.4.0 | Read and write `.xlsx` processing report |
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
- **Linux** (Ubuntu 22.04 LTS recommended) — the bot runs headless Chromium with automated login via env variables. See [GCP VM Setup](#gcp-vm-setup) below.
- A **Google account** with an [App Password](https://support.google.com/accounts/answer/185833) enabled for SMTP (used for email notifications)
- An **Anthropic API key** with access to Claude
- **Veritone Hire credentials** (username and password) — passed via `VERITONE_USERNAME` and `VERITONE_PASSWORD` env variables

---

## Setup

### 1. Clone the repository

```bash
git clone <repository-url>
cd veritone-rpa
```

### 2. Install dependencies

```bash
npm install
```

### 3. Install Playwright browsers (headless Chromium)

```bash
npx playwright install chromium
```

### 4. Configure environment variables

Copy the template and fill in your values:

```bash
cp .env.template .env
```

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key |
| `RUN_MODE` | No | `production` (enforces 7 PM–7 AM window) or `testing` (skips window check); default: `production` |
| `LOOKBACK_DAYS` | No | How many days back to look for adverts; default: `30` |
| `EMAIL_USER` | Yes | Gmail address used to send notifications |
| `EMAIL_PASS` | Yes | Gmail App Password for the sending account |
| `VERITONE_USERNAME` | Yes | Veritone Hire login username (no manual login fallback in headless mode) |
| `VERITONE_PASSWORD` | Yes | Veritone Hire login password |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | Yes | Service account email — same as the note-adding RPA |
| `GOOGLE_PRIVATE_KEY` | Yes | Service account private key (include `\n` line breaks) |
| `GOOGLE_SHEET_ID` | Yes | Google Sheet ID — same sheet as the note-adding RPA |

### 5. Build

```bash
npm run build
```

### 6. Run locally

**Development** (no build required):
```bash
npm run dev
```

**Production** (after building):
```bash
npm start
```

---

## GCP VM Setup

The bot is deployed on a GCP Compute Engine instance (e2-medium, Ubuntu 22.04 LTS) with the following configuration:

### 1. Instance Setup

Create or update your GCP instance with:
- **Machine type:** e2-medium (2 vCPUs, 4 GB memory)
- **Image:** Ubuntu 22.04 LTS
- **Boot disk:** 20 GB SSD
- **Startup script:** Install Node.js, npm, and pm2

### 2. Instance startup script

```bash
#!/bin/bash
set -euo pipefail

# Update and install dependencies
sudo apt-get update
sudo apt-get install -y curl wget gnupg ca-certificates

# Install Node.js (v20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install pm2 globally
sudo npm install -g pm2

# Set pm2 to start on boot
sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u $(whoami) --hp /home/$(whoami)
```

### 3. Clone and deploy

Once the instance is running:

```bash
cd /home/ubuntu
git clone <repository-url>
cd veritone-rpa
npm install
npm run build

# Create .env with GCP secrets
cat > .env << 'EOF'
ANTHROPIC_API_KEY=sk-ant-...
EMAIL_USER=sustdev3@gmail.com
EMAIL_PASS=xxxx xxxx xxxx xxxx
VERITONE_USERNAME=...
VERITONE_PASSWORD=...
RUN_MODE=production
LOOKBACK_DAYS=30
EOF

chmod 600 .env

# Start with pm2
pm2 start dist/main.js --name "veritone-rpa" --cron "0 22 * * 0-5"
pm2 save
```

### 4. Monitor the bot

```bash
# View logs in real-time
pm2 logs veritone-rpa

# View status
pm2 status

# View all processes
pm2 monit
```

---

## Architecture

### Pagination Optimization (Bookmarks)

The bot processes candidates in three stages, each with different pagination strategies to balance accuracy and efficiency:

#### Stage 1: Candidate Collection
**Strategy:** Full re-scrape (no bookmark)
- Paginates through all filtered candidates every run
- Captures fresh flag status from the UI for every candidate (including those already seen)
- Records the first candidate ID seen as `newLastProcessedId` for next run's bookmark

**Why:** Ensures accurate detection of manually-flagged candidates. If HR manually flags a candidate between runs, the collector sees the updated flag status.

#### Stage 2: Candidate Flagging
**Strategy:** Bookmark-based stop
- Reads `previousLastProcessedId` from collector
- Stops pagination when reaching this ID (bookmark)
- Falls back to full pagination if bookmark not found after 3 empty pages

**Why:** Most filtered candidates haven't changed. Skipping already-seen candidates saves browser interactions and improves speed.

#### Stage 3: Resume Review
**Strategy:** Bookmark-based stop + LLM skip
- Reads `lastProcessedId` from previous run's JSON state
- Stops pagination when reaching this ID
- Skips LLM review for candidates already marked as "pass" in previous runs
- Falls back to full pagination if bookmark not found after 3 empty pages

**Why:** LLM calls are expensive. Skipping already-reviewed candidates minimizes API usage while maintaining accuracy.

### Persistent Run State

The bot saves two files per advert in the `temp/` folder:

#### `passing-{advertId}.json`
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
- `passingCandidates` = all candidates who passed keyword + location filter (with fresh flag status from tonight's scrape)
- `lastProcessedId` = first candidate ID from page 1 (used as bookmark by flagger)

#### `resume-review-{advertId}.json`
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
- `results` = all LLM review decisions (pass/fail with reason and category)
- `lastProcessedId` = first candidate ID from page 1 (used as bookmark by reviewer for next run)
- Candidates with `ai_decision: "pass"` are skipped in next run without re-opening their modal

### Questionnaire-Based Purple Flagging

When the note-adding RPA adds a screening form note to a candidate's Veritone profile, the pre-screening RPA reads it during resume review. If the candidate's answers meet any disqualifying criteria, they are immediately purple-flagged and the LLM CV review is skipped:

| Criterion | Disqualifying value |
|---|---|
| Driver's licence | No |
| Gets to work by | Public Transport, Get a Lift, or Other |
| Available to work full time | No |
| Able to start | Longer |
| Finished last job | More than a month |

If no screening note is found, or the candidate passes all criteria, the normal LLM review proceeds.

### Email Reports

At the end of each run, the bot sends an email summary with:
- Breakdown of success/skip/error counts
- Detailed per-advert results (keyword filter count, resume review pass count, rejection categories)
- **Number of applicants who answered questions** — cumulative total read from the `Summary` tab of the shared Google Sheet (written by the note-adding RPA). Matched by `refNumber + datePosted`. Shows `—` if no data is available for that advert
- Run duration and elapsed time per advert

Email recipients are hardcoded in `src/shared/email-service.ts` and include bruce@8020green.com and other team members.
