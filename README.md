# LinkedIn DM Scheduler

A production-ready Chrome Extension that lets you schedule LinkedIn direct messages and automatically sends them at the chosen date and time.

## Features

- **Schedule Messages** — Pick a recipient, message, date, time, and timezone.
- **Message Queue** — View, edit, or delete pending messages.
- **Recurring Messages** — Weekly or monthly recurring sends.
- **Message Templates** — Save reusable templates with `{name}`, `{firstName}`, and other placeholders.
- **Contact Autocomplete** — Refresh your LinkedIn connections list directly from the messaging page.
- **Send History & Dashboard** — Track sent/failed messages with success-rate stats.
- **Browser Notifications** — Get notified when a message is sent or fails.
- **Import / Export** — Backup and restore scheduled messages and templates as JSON.
- **Timezone Support** — Detects your local timezone and lets you override it per message.
- **Dark / Light Mode** — Toggle between themes in Settings.

## Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top-right corner.
3. Click **Load unpacked**.
4. Select the `linkedin-dm-scheduler` folder.
5. The extension icon will appear in your toolbar.

## Permissions

The extension requests only what it needs:

- `storage` — Save messages, templates, and settings locally.
- `alarms` — Check every minute for due messages.
- `notifications` — Show send/failure notifications.
- `activeTab` — Interact with the current LinkedIn tab when sending.
- Host permission for `https://www.linkedin.com/messaging/*` — Automate message sending on LinkedIn.

## Usage

1. Open the extension popup and go to the **Schedule** tab.
2. Type or select a recipient, write your message (or pick a template), choose the date/time, and set the timezone.
3. Click **Save Message**.
4. The background service worker will automatically send the message when the time arrives.
5. View pending items in **Queue**, sent/failed items in **History**, and manage templates in **Templates**.

## File Structure

```
linkedin-dm-scheduler/
├── manifest.json
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── background/
│   └── service-worker.js
├── content/
│   └── linkedin.js
├── utils/
│   ├── storage.js
│   └── templates.js
├── assets/
│   └── icons/
│       ├── icon16.svg
│       ├── icon48.svg
│       └── icon128.svg
└── README.md
```

## How It Works

- **Background Service Worker** (`background/service-worker.js`) registers a one-minute alarm. On each tick it loads pending messages and dispatches any that are due to a LinkedIn messaging tab.
- **Content Script** (`content/linkedin.js`) runs on `https://www.linkedin.com/messaging/*`. It searches for the recipient, opens the conversation, types the message, clicks send, and reports the result back to the service worker.
- **Popup** (`popup/`) provides the full UI for scheduling, queue management, templates, history, settings, and import/export.
- **Storage** (`utils/storage.js`) persists all data using `chrome.storage.local`.
- **Templates** (`utils/templates.js`) extract `{key}` placeholders and substitute them when a message is saved.

## Notes

- The extension must remain enabled for scheduled messages to send.
- LinkedIn’s DOM changes from time to time; the content script includes multiple selector fallbacks and retry logic to stay resilient.
- Keep Chrome open and, if necessary, allow it to run in the background for the alarm to fire reliably.

## License

MIT
