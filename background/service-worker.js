/**
 * Background service worker for LinkedIn DM Scheduler.
 * - Creates a 1-minute alarm on install/startup.
 * - Checks pending messages and dispatches them to the content script.
 * - Updates status, recurs recurring messages, and shows notifications.
 */

importScripts('../utils/storage.js');

const ALARM_NAME = 'check-scheduled-messages';
const LINKEDIN_MESSAGING_URL = 'https://www.linkedin.com/messaging/';
let isChecking = false;

// Ensure the periodic check alarm exists.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  resetSendingMessages();
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    }
  });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkScheduledMessages();
  }
});

/**
 * Main scheduler loop.
 */
async function checkScheduledMessages() {
  if (isChecking) return;
  isChecking = true;
  try {
    const messages = await Storage.getMessages();
    const settings = await Storage.getSettings();
    const now = Date.now();

    const due = messages.filter(
      (m) => m.status === 'pending' && m.scheduledAt && m.scheduledAt <= now
    );

    for (const message of due) {
      // Prevent overlapping sends for the same message.
      await Storage.updateMessage(message.id, { status: 'sending' });
      await dispatchMessage(message, settings);
    }
  } catch (err) {
    console.error('[Scheduler] Error checking messages:', err);
  } finally {
    isChecking = false;
  }
}

/**
 * Reset any messages stuck in 'sending' back to pending after a restart.
 */
async function resetSendingMessages() {
  try {
    const messages = await Storage.getMessages();
    let changed = false;
    for (const m of messages) {
      if (m.status === 'sending') {
        m.status = 'pending';
        changed = true;
      }
    }
    if (changed) await Storage.setMessages(messages);
  } catch (err) {
    console.error('[Scheduler] Error resetting sending messages:', err);
  }
}

/**
 * Dispatches a single message to a LinkedIn tab.
 * If a profileUrl is present the tab is navigated to that profile first;
 * otherwise the existing messaging flow is used.
 */
async function dispatchMessage(message, settings) {
  let tab;
  try {
    if (message.profileUrl) {
      tab = await ensureProfileTab(message.profileUrl);
    } else {
      tab = await ensureMessagingTab();
    }
  } catch (err) {
    await markFailed(message.id, `Could not open LinkedIn tab: ${err.message}`);
    return;
  }

  console.log('[LDMS BG] sending to tab', tab.id, 'url:', tab.url);

  // Explicitly inject the content script into the exact tab so we know it is
  // present before sending the command.
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['utils/storage.js', 'utils/templates.js', 'content/linkedin.js']
    });
  } catch (err) {
    console.warn('[LDMS BG] executeScript warning:', err.message);
  }

  // Use an out-of-band completion message instead of holding the message
  // channel open, which can time out during long navigation/type/send flows.
  const COMPLETE_TIMEOUT_MS = 90000;
  let completed = false;

  const completionPromise = new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      if (!completed) {
        completed = true;
        cleanup();
        resolve({ success: false, error: 'No sendComplete received within 90 seconds' });
      }
    }, COMPLETE_TIMEOUT_MS);

    function onMessage(request, sender) {
      if (
        request.action === 'sendComplete' &&
        request.messageId === message.id
      ) {
        if (completed) return;
        completed = true;
        clearTimeout(timeoutId);
        cleanup();
        resolve({
          success: !!request.success,
          error: request.error || null
        });
      }
    }

    function cleanup() {
      chrome.runtime.onMessage.removeListener(onMessage);
    }

    chrome.runtime.onMessage.addListener(onMessage);
  });

  try {
    await chrome.tabs.sendMessage(tab.id, {
      action: 'sendLinkedInMessage',
      payload: {
        id: message.id,
        recipient: message.recipient,
        text: message.text,
        profileUrl: message.profileUrl || null,
        profileSlug: message.profileSlug || null
      }
    });
  } catch (err) {
    // Tab may not have the content script ready yet.
    await markFailed(message.id, `Dispatch error: ${err.message}`);
    return;
  }

  const result = await completionPromise;

  if (result.success) {
    await markSent(message, settings);
  } else {
    await markFailed(message.id, result.error || 'Unknown error from content script');
  }
}

/**
 * Returns an existing LinkedIn messaging tab or creates one.
 */
function ensureMessagingTab() {
  return ensureLinkedInTab(LINKEDIN_MESSAGING_URL);
}

/**
 * Navigates an existing LinkedIn tab (or creates one) to the profile URL and
 * waits for the page to load before returning it.
 */
function ensureProfileTab(profileUrl) {
  return ensureLinkedInTab(profileUrl, true);
}

/**
 * Generic helper to get or create a LinkedIn tab at a specific URL.
 */
function ensureLinkedInTab(targetUrl, requireExactUrl = false) {
  return new Promise((resolve, reject) => {
    const queryUrl = requireExactUrl ? targetUrl : ['https://www.linkedin.com/*'];
    chrome.tabs.query(
      { url: queryUrl },
      (tabs) => {
        const usableTab =
          tabs && tabs.find((t) => t.url && t.url.startsWith('https://www.linkedin.com/'));

        let tabId = null;
        let resolved = false;

        const timeoutId = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            chrome.tabs.onUpdated.removeListener(onUpdated);
            reject(new Error('Timeout waiting for LinkedIn tab to load'));
          }
        }, 30000);

        const onUpdated = (updatedTabId, changeInfo, updatedTab) => {
          if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
          if (resolved) return;
          resolved = true;
          clearTimeout(timeoutId);
          chrome.tabs.onUpdated.removeListener(onUpdated);
          // Give the content script time to initialize and for LinkedIn's
          // dynamic chrome (action bar, messaging sidebar) to render.
          setTimeout(() => resolve({ id: tabId, url: updatedTab.url || targetUrl }), 3500);
        };

        chrome.tabs.onUpdated.addListener(onUpdated);

        const navigate = (id) => {
          tabId = id;
          chrome.tabs.update(id, { url: targetUrl, active: false }, () => {
            if (chrome.runtime.lastError) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                reject(new Error(chrome.runtime.lastError.message));
              }
            }
          });
        };

        if (usableTab) {
          navigate(usableTab.id);
        } else {
          chrome.tabs.create({ url: targetUrl, active: false }, (createdTab) => {
            if (chrome.runtime.lastError) {
              if (!resolved) {
                resolved = true;
                clearTimeout(timeoutId);
                chrome.tabs.onUpdated.removeListener(onUpdated);
                reject(new Error(chrome.runtime.lastError.message));
              }
              return;
            }
            tabId = createdTab.id;
          });
        }
      }
    );
  });
}

/**
 * Marks a message as sent, recurs if needed, and notifies.
 */
async function markSent(message, settings) {
  const sentAt = Date.now();
  const updates = { status: 'sent', sentAt, error: null };
  await Storage.updateMessage(message.id, updates);

  if (message.recurrence) {
    const nextScheduledAt = computeNextOccurrence(message.scheduledAt, message.recurrence);
    if (nextScheduledAt) {
      await Storage.addMessage({
        recipient: message.recipient,
        text: message.text,
        timezone: message.timezone,
        recurrence: message.recurrence,
        scheduledAt: nextScheduledAt,
        status: 'pending',
        profileUrl: message.profileUrl || null,
        profileSlug: message.profileSlug || null
      });
    }
  }

  if (settings.notifications) {
    showNotification(
      'Message sent',
      `Your scheduled message to ${message.recipient} was sent.`
    );
  }
}

/**
 * Marks a message as failed and notifies.
 */
async function markFailed(id, error) {
  await Storage.updateMessage(id, { status: 'failed', error: String(error) });
  const settings = await Storage.getSettings();
  if (settings.notifications) {
    showNotification('Message failed', String(error).slice(0, 120));
  }
}

/**
 * Computes the next occurrence for recurring messages.
 */
function computeNextOccurrence(timestamp, recurrence) {
  const date = new Date(timestamp);
  switch (recurrence) {
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    default:
      return null;
  }
  return date.getTime();
}

/**
 * Shows a Chrome notification.
 */
function showNotification(title, message) {
  chrome.notifications.create(
    `lids-${Date.now()}`,
    {
      type: 'basic',
      iconUrl: 'assets/icons/icon48.svg',
      title,
      message
    },
    (notificationId) => {
      if (chrome.runtime.lastError) {
        console.error('[Scheduler] Notification error:', chrome.runtime.lastError);
      }
    }
  );
}

// Listen for status / stats requests from the popup.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getStats') {
    Storage.getMessages()
      .then((messages) => {
        const total = messages.filter(
          (m) => m.status === 'sent' || m.status === 'failed'
        ).length;
        const sent = messages.filter((m) => m.status === 'sent').length;
        const failed = messages.filter((m) => m.status === 'failed').length;
        const pending = messages.filter((m) => m.status === 'pending').length;
        const successRate = total ? Math.round((sent / total) * 100) : 0;
        sendResponse({ total, sent, failed, pending, successRate });
      })
      .catch((err) => {
        console.error('[Scheduler] getStats error:', err);
        sendResponse({ total: 0, sent: 0, failed: 0, pending: 0, successRate: 0 });
      });
    return true;
  }

  if (request.action === 'testNotification') {
    try {
      showNotification('LinkedIn DM Scheduler', 'Notifications are working.');
      sendResponse({ success: true });
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
    return true;
  }
});
