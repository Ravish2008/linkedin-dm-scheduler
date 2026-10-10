/**
 * Background service worker for LinkedIn DM Scheduler.
 * - Creates a 1-minute alarm on install/startup.
 * - Checks pending messages and dispatches them to the content script.
 * - Updates status, recurs recurring messages, and shows notifications.
 */

importScripts('../utils/storage.js', '../utils/campaign.js');

const ALARM_NAME = 'check-scheduled-messages';
const CAMPAIGN_ALARM_NAME = 'campaign-engine-tick';
const LINKEDIN_MESSAGING_URL = 'https://www.linkedin.com/messaging/';
let isChecking = false;
let isCampaignTicking = false;

// Tab IDs of tabs this extension created (for sends / profile ID lookups).
// Used to auto-close them after a send operation completes; user-owned tabs
// are never tracked here and therefore never closed by the extension.
const extensionCreatedTabs = new Set();

chrome.tabs.onRemoved.addListener((tabId) => {
  // Keep the set clean when tabs are closed manually or by the browser.
  extensionCreatedTabs.delete(tabId);
});

// Ensure the periodic check alarm exists.
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
});

chrome.runtime.onStartup.addListener(() => {
  resetSendingMessages();
  resetCampaignSendingStates();
  chrome.alarms.get(ALARM_NAME, (alarm) => {
    if (!alarm) {
      chrome.alarms.create(ALARM_NAME, { periodInMinutes: 1 });
    }
  });
  ensureCampaignAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    checkScheduledMessages();
  }
  if (alarm.name === CAMPAIGN_ALARM_NAME) {
    campaignEngineTick();
  }
});

/**
 * Ensure the campaign engine alarm exists when at least one campaign is running.
 */
async function ensureCampaignAlarm() {
  const campaigns = await Storage.getCampaigns();
  const anyRunning = campaigns.some((c) => c.status === 'running');
  const alarm = await chrome.alarms.get(CAMPAIGN_ALARM_NAME);
  if (anyRunning && !alarm) {
    chrome.alarms.create(CAMPAIGN_ALARM_NAME, { periodInMinutes: 1 });
  } else if (!anyRunning && alarm) {
    chrome.alarms.clear(CAMPAIGN_ALARM_NAME);
  }
}

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
 * Reset any campaign recipients stuck in 'sending' back to pending after a
 * service-worker restart.
 */
async function resetCampaignSendingStates() {
  try {
    const campaigns = await Storage.getCampaigns();
    let changed = false;
    for (const c of campaigns) {
      if (!Array.isArray(c.recipients)) continue;
      for (const r of c.recipients) {
        if (r.status === 'sending') {
          r.status = 'pending';
          changed = true;
        }
      }
    }
    if (changed) await Storage.setCampaigns(campaigns);
  } catch (err) {
    console.error('[Campaign] Error resetting sending states:', err);
  }
}

// ---------------------------------------------------------------------------
// Campaign execution engine
// ---------------------------------------------------------------------------

/**
 * One engine tick: advance every running campaign by at most one send.
 */
async function campaignEngineTick() {
  if (isCampaignTicking) return;
  isCampaignTicking = true;
  try {
    const campaigns = await Storage.getCampaigns();
    const running = campaigns.filter((c) => c.status === 'running');
    for (const campaign of running) {
      await advanceCampaign(campaign.id);
    }
    await ensureCampaignAlarm();
  } catch (err) {
    console.error('[Campaign] engine tick error:', err);
  } finally {
    isCampaignTicking = false;
  }
}

/**
 * Advance a single campaign: respect caps/hours/cooldown, send the next
 * pending recipient, then schedule the following send.
 */
async function advanceCampaign(campaignId) {
  let campaign = await Storage.getCampaign(campaignId);
  if (!campaign || campaign.status !== 'running') return;

  // All recipients finished?
  const remaining = (campaign.recipients || []).filter(
    (r) => r.status === 'pending' || r.status === 'sending'
  );
  if (remaining.length === 0) {
    await Storage.updateCampaign(campaignId, { status: 'completed' });
    const settings = await Storage.getSettings();
    if (settings.notifications) {
      showNotification('Campaign complete', `"${campaign.name || 'Campaign'}" finished sending.`);
    }
    return;
  }

  const now = Date.now();
  const gate = Campaign.canSendNow(campaign, now);
  if (!gate.ok) {
    // Nothing to do this tick; nextSendAt/cooldown/caps will re-gate us.
    return;
  }

  // Pick the next pending recipient.
  const recipient = (campaign.recipients || []).find((r) => r.status === 'pending');
  if (!recipient) return;

  await updateCampaignRecipient(campaignId, recipient.id, { status: 'sending' });

  // Resolve profile info (ID + merge fields) from the profile page.
  const info = await resolveProfileInfo(recipient);
  if (info) {
    recipient.profileId = info.profileId || recipient.profileId;
    recipient.name = info.fullName || recipient.name;
    recipient.fullName = info.fullName;
    recipient.firstName = info.firstName;
    recipient.company = info.company;
    await updateCampaignRecipient(campaignId, recipient.id, {
      profileId: recipient.profileId,
      name: recipient.name,
      fullName: recipient.fullName,
      firstName: recipient.firstName,
      company: recipient.company
    });
  }

  const text = Campaign.applyMergeFields(campaign.message, recipient);
  const result = await sendCampaignMessage(recipient, text);

  campaign = await Storage.getCampaign(campaignId);
  if (!campaign) return;

  const today = Campaign.dayKey(now);
  const thisWeek = Campaign.weekKey(now);
  const sentToday = campaign.dayKey === today ? campaign.sentToday || 0 : 0;
  const sentThisWeek = campaign.weekKey === thisWeek ? campaign.sentThisWeek || 0 : 0;

  if (result.success) {
    await updateCampaignRecipient(campaignId, recipient.id, { status: 'sent', sentAt: now, error: null });

    // Log to History so the dashboard picks it up.
    await Storage.addMessage({
      recipient: recipient.name || recipient.slug,
      text,
      timezone: (await Storage.getSettings()).timezone,
      recurrence: 'none',
      scheduledAt: now,
      sentAt: now,
      status: 'sent',
      profileUrl: recipient.profileUrl || null,
      profileSlug: recipient.slug || null,
      profileId: recipient.profileId || null,
      campaignId
    });

    const pacing = Campaign.nextDelayAfterSend(campaign);
    const updates = {
      dayKey: today,
      weekKey: thisWeek,
      sentToday: sentToday + 1,
      sentThisWeek: sentThisWeek + 1,
      sessionCount: pacing.sessionCount,
      nextBreakAt: pacing.nextBreakAt,
      nextSendAt: now + pacing.delayMs,
      lastError: null
    };
    await Storage.updateCampaign(campaignId, updates);

    // Delays can now be configured in seconds, but the engine alarm only
    // fires once a minute. For sub-minute delays, schedule a precise
    // best-effort follow-up tick; the periodic alarm remains the backstop
    // if the service worker is suspended before it fires.
    if (pacing.delayMs < 60000) {
      setTimeout(() => {
        campaignEngineTick().catch((err) =>
          console.error('[Campaign] Follow-up tick failed:', err)
        );
      }, pacing.delayMs);
    }
  } else {
    await updateCampaignRecipient(campaignId, recipient.id, {
      status: 'failed',
      error: result.error || 'Send failed'
    });

    const cooldownMs = Campaign.errorCooldownMs();
    await Storage.updateCampaign(campaignId, {
      dayKey: today,
      weekKey: thisWeek,
      cooldownUntil: now + cooldownMs,
      lastError: result.error || 'Send failed'
    });
  }
}

/**
 * Update one recipient inside a campaign's recipients array.
 */
async function updateCampaignRecipient(campaignId, recipientId, updates) {
  const campaign = await Storage.getCampaign(campaignId);
  if (!campaign) return;
  const recipients = (campaign.recipients || []).map((r) =>
    r.id === recipientId ? { ...r, ...updates } : r
  );
  await Storage.updateCampaign(campaignId, { recipients });
}

/**
 * Visit a recipient's profile page and extract ID + merge fields.
 */
async function resolveProfileInfo(recipient) {
  if (!recipient.profileUrl) return null;
  try {
    const tab = await ensureLinkedInTab(recipient.profileUrl, true);
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/linkedin.js']
      });
    } catch (err) {
      console.warn('[Campaign] executeScript warning (profile):', err.message);
    }

    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response = null;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'extractProfileInfo' });
      } catch (err) {
        console.warn(`[Campaign] extractProfileInfo attempt ${attempt} error:`, err.message);
      }
      if (response && response.success) {
        return {
          profileId: response.profileId || null,
          fullName: response.fullName || null,
          firstName: response.firstName || null,
          company: response.company || null
        };
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
  } catch (err) {
    console.warn('[Campaign] profile info resolution failed:', err.message);
  }
  return null;
}

/**
 * Send one campaign message via the compose-URL (or messaging) flow.
 * Reuses the same tab/sendMessage/sendComplete mechanism as single sends,
 * but does not write to the messages store (advanceCampaign handles that).
 */
function sendCampaignMessage(recipient, text) {
  return new Promise(async (resolve) => {
    let targetUrl = LINKEDIN_MESSAGING_URL;
    let requireExactUrl = false;
    let composePrefilled = false;

    if (recipient.profileId) {
      targetUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=urn:li:fsd_profile:${recipient.profileId}&recipient=${recipient.profileId}`;
      requireExactUrl = true;
      composePrefilled = true;
    }

    let tab;
    try {
      tab = await ensureLinkedInTab(targetUrl, requireExactUrl);
    } catch (err) {
      await closeExtensionCreatedTabs();
      resolve({ success: false, error: `Could not open tab: ${err.message}` });
      return;
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content/linkedin.js']
      });
    } catch (err) {
      console.warn('[Campaign] executeScript warning:', err.message);
    }

    const messageId = `campaign-${recipient.id}`;
    const COMPLETE_TIMEOUT_MS = 90000;
    let completed = false;

    const timeoutId = setTimeout(() => {
      if (completed) return;
      completed = true;
      chrome.runtime.onMessage.removeListener(onMessage);
      closeExtensionCreatedTabs().finally(() =>
        resolve({ success: false, error: 'No sendComplete within 90s' })
      );
    }, COMPLETE_TIMEOUT_MS);

    function onMessage(request) {
      if (request.action === 'sendComplete' && request.messageId === messageId) {
        if (request.success && !completed) {
          completed = true;
          clearTimeout(timeoutId);
          chrome.runtime.onMessage.removeListener(onMessage);
          closeExtensionCreatedTabs().finally(() => resolve({ success: true }));
        }
      }
    }
    chrome.runtime.onMessage.addListener(onMessage);

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'sendLinkedInMessage',
        payload: {
          id: messageId,
          recipient: recipient.name || recipient.slug,
          text,
          profileSlug: recipient.slug || null,
          composePrefilled
        }
      });
    } catch (err) {
      if (!completed) {
        completed = true;
        clearTimeout(timeoutId);
        chrome.runtime.onMessage.removeListener(onMessage);
        await closeExtensionCreatedTabs();
        resolve({ success: false, error: `Dispatch error: ${err.message}` });
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Campaign control actions (from the popup)
// ---------------------------------------------------------------------------

async function startCampaign(id) {
  const campaign = await Storage.getCampaign(id);
  if (!campaign) return { success: false, error: 'Campaign not found' };
  const updates = { status: 'running', lastError: null };
  if (!campaign.warmupStartAt && campaign.settings && campaign.settings.warmup) {
    updates.warmupStartAt = Date.now();
  }
  if (!campaign.nextBreakAt) {
    updates.nextBreakAt = Campaign.randInt(8, 12);
  }
  updates.nextSendAt = Date.now(); // eligible immediately (gate still applies)
  await Storage.updateCampaign(id, updates);
  await ensureCampaignAlarm();
  return { success: true };
}

async function pauseCampaign(id) {
  await Storage.updateCampaign(id, { status: 'paused' });
  await ensureCampaignAlarm();
  return { success: true };
}

async function resumeCampaign(id) {
  return startCampaign(id);
}

async function cancelCampaign(id) {
  const campaign = await Storage.getCampaign(id);
  if (!campaign) return { success: false, error: 'Campaign not found' };
  const recipients = (campaign.recipients || []).map((r) =>
    r.status === 'pending' || r.status === 'sending' ? { ...r, status: 'skipped', error: 'Cancelled' } : r
  );
  await Storage.updateCampaign(id, { status: 'cancelled', recipients });
  await ensureCampaignAlarm();
  return { success: true };
}

/**
 * Dispatches a single message to the LinkedIn messaging tab.
 * - When a profileUrl is present, the internal profile ID is resolved (with
 *   caching) and the direct compose URL is used, which pre-fills the
 *   recipient — no typeahead search needed.
 * - Otherwise the messaging page compose flow is used, with profileSlug for
 *   typeahead disambiguation of duplicate names.
 */
async function dispatchMessage(message, settings) {
  let targetUrl = LINKEDIN_MESSAGING_URL;
  let requireExactUrl = false;
  let composePrefilled = false;

  if (message.profileUrl) {
    let profileId = message.profileId || null;
    if (!profileId) {
      profileId = await resolveProfileId(message);
    }
    if (profileId) {
      targetUrl = `https://www.linkedin.com/messaging/compose/?profileUrn=urn:li:fsd_profile:${profileId}&recipient=${profileId}`;
      requireExactUrl = true;
      composePrefilled = true;
    }
    // If no ID could be resolved, fall back to the plain messaging flow.
  }

  let tab;
  try {
    tab = await ensureLinkedInTab(targetUrl, requireExactUrl);
  } catch (err) {
    await markFailed(message.id, `Could not open LinkedIn tab: ${err.message}`);
    await closeExtensionCreatedTabs();
    return;
  }

  console.log('[LDMS BG] sending to tab', tab.id, 'url:', tab.url, 'composePrefilled:', composePrefilled);

  // Inject only the content script. utils/storage.js and utils/templates.js
  // are already loaded by the manifest content_scripts declaration; injecting
  // them again here would throw "Identifier has already been declared".
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content/linkedin.js']
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
        // Multiple frames may respond; the first successful one wins.
        // Failures are ignored until the timeout expires.
        if (request.success) {
          if (completed) return;
          completed = true;
          clearTimeout(timeoutId);
          cleanup();
          resolve({ success: true, error: null });
        } else {
          console.log('[LDMS BG] frame reported failure:', request.error);
        }
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
        profileSlug: message.profileSlug || null,
        composePrefilled
      }
    });
  } catch (err) {
    // Tab may not have the content script ready yet.
    await markFailed(message.id, `Dispatch error: ${err.message}`);
    await closeExtensionCreatedTabs();
    return;
  }

  const result = await completionPromise;

  if (result.success) {
    await markSent(message, settings);
  } else {
    await markFailed(message.id, result.error || 'Unknown error from content script');
  }

  // Close any tabs the extension opened for this send operation (the send
  // tab and any profile-ID lookup tab). User-owned tabs are never tracked
  // and therefore never closed.
  await closeExtensionCreatedTabs();
}

/**
 * Closes all tabs that were created by the extension during a send
 * operation. Tabs already closed manually (or by the browser) are silently
 * skipped; the tracked set is cleared regardless.
 */
async function closeExtensionCreatedTabs() {
  const tabIds = Array.from(extensionCreatedTabs);
  extensionCreatedTabs.clear();

  for (const tabId of tabIds) {
    try {
      await chrome.tabs.remove(tabId);
      console.log('[LDMS BG] closed extension-created tab:', tabId);
    } catch (err) {
      // Tab was already closed (manually or otherwise); nothing to do.
      console.log('[LDMS BG] tab already gone:', tabId);
    }
  }
}

/**
 * Returns an existing LinkedIn messaging tab or creates one.
 */
function ensureMessagingTab() {
  return ensureLinkedInTab(LINKEDIN_MESSAGING_URL);
}

/**
 * Resolves the internal LinkedIn profile ID for a message's profileUrl by
 * visiting the profile page and asking the content script to extract it.
 * The result is cached on the message record so it only happens once.
 * Returns the ID or null on failure.
 */
async function resolveProfileId(message) {
  if (!message.profileUrl) {
    console.warn('[LDMS BG] resolveProfileId called without a profileUrl');
    return null;
  }

  console.log('[LDMS BG] resolveProfileId for:', message.profileUrl);

  try {
    const tab = await ensureLinkedInTab(message.profileUrl, true);
    console.log('[LDMS BG] profile tab ready:', tab.id, tab.url);

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/linkedin.js']
      });
    } catch (err) {
      console.warn('[LDMS BG] executeScript warning (profile):', err.message);
    }

    // Profile data renders dynamically; retry the extraction a few times.
    const MAX_ATTEMPTS = 5;
    const RETRY_DELAY_MS = 2000;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response = null;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'extractProfileId' });
      } catch (err) {
        console.warn(`[LDMS BG] extractProfileId attempt ${attempt} error:`, err.message);
      }

      if (response && response.success && response.profileId) {
        console.log(`[LDMS BG] extracted profileId on attempt ${attempt}:`, response.profileId);
        await Storage.updateMessage(message.id, { profileId: response.profileId });
        return response.profileId;
      }

      console.warn(
        `[LDMS BG] extractProfileId attempt ${attempt}/${MAX_ATTEMPTS} returned:`,
        response ? `${response.success ? 'success' : 'failure'}: ${response.error || 'no ID'}` : 'no response'
      );

      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  } catch (err) {
    console.warn('[LDMS BG] profile ID extraction failed:', err.message);
  }

  console.warn('[LDMS BG] could not resolve profile ID; falling back to typeahead flow');
  return null;
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
            // Remember that this tab was created by the extension so it can
            // be auto-closed after the send operation finishes.
            extensionCreatedTabs.add(tabId);
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
        profileSlug: message.profileSlug || null,
        profileId: message.profileId || null
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
      iconUrl: 'assets/icons/icon48.png',
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

  // Campaign control actions from the popup.
  if (request.action === 'campaignControl') {
    const { command, campaignId } = request;
    let handler = null;
    if (command === 'start') handler = startCampaign;
    else if (command === 'pause') handler = pauseCampaign;
    else if (command === 'resume') handler = resumeCampaign;
    else if (command === 'cancel') handler = cancelCampaign;

    if (!handler) {
      sendResponse({ success: false, error: 'Unknown campaign command' });
      return false;
    }

    handler(campaignId)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
