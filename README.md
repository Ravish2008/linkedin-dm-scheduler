# 📅 LinkedIn DM Scheduler

> A Chrome extension for scheduling and automating LinkedIn direct messages — from single scheduled DMs to full bulk-messaging campaigns with human-like pacing.

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-34A853?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/develop)
[![Chrome](https://img.shields.io/badge/Chrome-114%2B-4285F4?logo=googlechrome&logoColor=white)](https://www.google.com/chrome/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Version](https://img.shields.io/badge/Version-1.0.0-0A66C2?logo=linkedin&logoColor=white)](manifest.json)

## ✨ Features

### ⏰ Scheduled Messages
- Set a specific **date, time, and timezone** per message — sent automatically when due
- Optional **weekly / monthly recurrence**
- **Queue** view with edit / delete for pending messages, **History** with success-rate stats

### 📣 Bulk Messaging Campaigns
- Paste a list of **LinkedIn profile URLs** — each is parsed into a tracked recipient
- Configurable pacing to mimic human behavior:
  | Setting | Range | Default |
  |---|---|---|
  | Delay between messages | 10 s – 30 min (min) / 30 s – 60 min (max) | 3 – 8 min |
  | Active hours | any start / end time (overnight windows supported) | 09:00 – 18:00 |
  | Daily cap *(optional)* | 10 – 100, or **unlimited** | unlimited |
  | Weekly cap *(optional)* | 50 – 200, or **unlimited** | unlimited |
  | Warm-up mode | 5 / day ramping to full daily cap over 5 days | off |

### 🛡️ Anti-Detection Pacing
- **Gaussian-distributed delays** (not uniform) between min and max
- **Session breaks** — after every 8–12 messages, a 15–30 min pause
- **Error cooldown** — a failed send pauses the campaign for 1–2 hours
- **Warm-up mode** — start slow (5 / day) and ramp up to your daily cap over 5 days

### 🔖 Merge Fields
- `{name}` — auto-filled from each recipient's LinkedIn profile
- `{{company}}`, `{{role}}`, … — **custom per-recipient placeholders**: type them in your message (or use a template) and fill in the value for each recipient right in the campaign builder

### 📋 Template Management
- Save / edit / delete reusable message templates
- Templates can contain `{name}` and any custom `{{placeholders}}`

### 📊 Campaign Dashboard
- Live **progress bar** and stats (sent / total, failures, skips)
- **Per-recipient status** — pending, sending, sent, failed, skipped
- **Start / Pause / Resume / Cancel** controls; edit draft or paused campaigns without losing sent progress

### 🧠 Smart Profile Targeting
- **Profile ID caching via compose URL** — resolves each recipient's internal LinkedIn profile ID once (cached on the recipient), then opens the pre-filled `linkedin.com/messaging/compose/?profileUrn=…` page: no fragile name-search flow
- **Voyager API profile data** — reads structured name / profile data from LinkedIn's internal API (with a multi-strategy DOM parser as fallback) for reliable merge-field values

### 🧰 Quality-of-Life
- **Form state persistence** — everything you type survives popup close / reopen (including campaign drafts and per-recipient placeholder values)
- **Auto tab cleanup** — tabs opened by the extension for sending are closed automatically after each send; your own tabs are never touched
- 🌙 **Dark / light mode** toggle
- 📤 **Import / Export** all messages, templates, and campaigns as JSON backup
- 🔔 **Browser notifications** on send success or failure

## 🚀 Installation

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked**.
5. Select the `linkedin-dm-scheduler` folder.
6. Pin the extension to your toolbar — you're done.

> **Note:** Log in to LinkedIn in the same browser before scheduling sends. The extension must remain installed and enabled (and Chrome running) for scheduled messages to fire.

## 📖 Usage Guide

### ⏰ Schedule a Single Message

1. Click the extension icon and open the **Schedule** tab.
2. Choose a recipient by **name** (autocomplete from your connections) and/or paste their **LinkedIn profile URL** — the URL is strongly recommended since it targets the exact person.
3. Write your message or pick a template; add any single-brace `{placeholders}` and fill in their values.
4. Set the **date and time** (your local timezone is shown; override it if needed) and an optional recurrence.
5. Click **Save Message** — the service worker sends it automatically when due.

### 📣 Create a Campaign

1. Open the **Campaign** tab and name your campaign.
2. Paste **LinkedIn profile URLs** (one per line) into the recipients box and click **Add** — each appears as a removable chip.
3. Write your message or pick a template. Any custom `{{placeholders}}` (like `{{company}}` or `{{role}}`) are detected automatically, and an input field for each appears under every recipient — fill in the per-recipient values.
4. Configure **delays** (number + seconds/minutes unit), **active hours**, **optional daily / weekly caps**, and **warm-up mode**.
5. Click **Create campaign** — it starts running immediately. Track progress on the dashboard; **Pause / Resume / Cancel** anytime, or click **Edit** on a draft / paused campaign to change anything without losing already-sent recipients.

### 📋 Use Templates with Placeholders

1. Open the **Templates** tab and create a template — e.g. `Hi {name}, great connecting! I saw you're a {{role}} at {{company}}.`
2. In the **Schedule** tab, select the template and fill in the single-brace placeholder values.
3. In the **Campaign** tab, select the template — `{name}` is filled automatically from each profile, and each `{{custom}}` field gets its own per-recipient input.

## 📁 Project Structure

```
linkedin-dm-scheduler/
├── manifest.json               # Extension manifest (MV3)
├── popup/
│   ├── popup.html              # Popup UI (Schedule, Queue, Templates, History, Campaign, Settings tabs)
│   ├── popup.css               # Light/dark theme styles
│   └── popup.js                # UI logic, campaign builder, form-state persistence
├── background/
│   └── service-worker.js       # Scheduling engine, campaign executor, send orchestration
├── content/
│   └── linkedin.js             # LinkedIn automation: compose-URL send flow, Voyager + DOM profile extraction
├── utils/
│   ├── storage.js              # chrome.storage.local CRUD (messages, templates, campaigns, settings)
│   ├── templates.js            # Template placeholder extraction / substitution
│   └── campaign.js             # Pure campaign logic: Gaussian delays, caps, active hours, warm-up, merge fields
└── assets/
    └── icons/                  # PNG icons (16 / 48 / 128 px)
```

## 🛠️ Tech Stack

- **Manifest V3** Chrome extension
- **Chrome APIs:** `chrome.storage.local` (persistence), `chrome.alarms` (1-minute scheduling tick), `chrome.scripting` (content-script injection, all frames), `chrome.tabs` (tab lifecycle + auto-cleanup), `chrome.notifications` (send results), `chrome.runtime` messaging
- **Vanilla HTML / CSS / JS** — no build step, no dependencies
- **LinkedIn integration:** compose-URL message flow, Voyager identity API (with CSRF token from the `JSESSIONID` cookie) and multi-strategy DOM fallback, main-world script injection for Ember-compatible typing
- All data stays in `chrome.storage.local` — nothing leaves your browser

## ⚠️ Disclaimer

This extension automates activity on LinkedIn and is **not affiliated with or endorsed by LinkedIn**. Automating messages may violate LinkedIn's User Agreement and could result in your account being **restricted or banned**. Use it at your own risk, keep volumes modest, and respect the platform's limits — the pacing features exist to help, but no tool can guarantee account safety.

## 📄 License

MIT
