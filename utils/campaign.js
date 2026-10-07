/**
 * Campaign helpers for LinkedIn DM Scheduler.
 * Pure functions for delays, caps, active hours, warm-up, and merge fields.
 * Used by the background execution engine; dependency-free so it can be
 * loaded via importScripts in the service worker.
 */

const Campaign = (() => {
  const DEFAULT_CAMPAIGN_SETTINGS = {
    dailyCap: 25,
    minDelaySec: 180,
    maxDelaySec: 480,
    activeStart: '09:00',
    activeEnd: '18:00',
    weeklyCap: 100,
    warmup: false
  };

  /**
   * Standard normal variate via Box-Muller transform.
   */
  function randNormal() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  }

  /**
   * Resolve delay settings in seconds. Supports the legacy minDelayMin /
   * maxDelayMin fields (pre-seconds campaigns) by converting them.
   */
  function delaySettings(settings) {
    const s = settings || DEFAULT_CAMPAIGN_SETTINGS;
    const minDelaySec = s.minDelaySec != null
      ? s.minDelaySec
      : Math.round((s.minDelayMin || 3) * 60);
    const maxDelaySec = s.maxDelaySec != null
      ? s.maxDelaySec
      : Math.round((s.maxDelayMin || 8) * 60);
    return { minDelaySec, maxDelaySec };
  }

  /**
   * Gaussian-distributed random delay between min and max (seconds), clamped.
   * Mean is the midpoint; ~99.7% of samples fall inside the range.
   * Returns milliseconds.
   */
  function gaussianDelayMs(minSec, maxSec) {
    const mean = (minSec + maxSec) / 2;
    const sd = (maxSec - minSec) / 6 || 0.5;
    let sample = mean + randNormal() * sd;
    sample = Math.max(minSec, Math.min(maxSec, sample));
    return Math.round(sample * 1000);
  }

  /**
   * Uniform random integer between min and max (inclusive).
   */
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }

  function weekKey(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + 4 - (d.getDay() || 7));
    const yearStart = new Date(d.getFullYear(), 0, 1);
    const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
    return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
  }

  function parseHHMM(str) {
    const [h, m] = String(str || '00:00').split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  }

  /**
   * Whether `ts` falls inside the active-hours window for the local timezone.
   * Supports overnight windows (e.g. 22:00 → 06:00).
   */
  function isWithinActiveHours(ts, activeStart, activeEnd) {
    const d = new Date(ts);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const start = parseHHMM(activeStart);
    const end = parseHHMM(activeEnd);
    if (start === end) return true; // treat equal as all-day
    if (start < end) return minutes >= start && minutes < end;
    return minutes >= start || minutes < end; // overnight window
  }

  /**
   * Milliseconds until the active window next opens from `ts`.
   * Returns 0 if already inside the window.
   */
  function msUntilActiveHours(ts, activeStart, activeEnd) {
    if (isWithinActiveHours(ts, activeStart, activeEnd)) return 0;
    const d = new Date(ts);
    const start = parseHHMM(activeStart);
    const minutes = d.getHours() * 60 + d.getMinutes();
    let deltaMin = start - minutes;
    if (deltaMin <= 0) deltaMin += 24 * 60;
    const target = new Date(d.getTime() + deltaMin * 60000);
    target.setSeconds(0, 0);
    return target.getTime() - ts;
  }

  /**
   * Effective daily cap given warm-up ramp: 5/day on day 1, ramping linearly
   * to the full cap over 5 days. Returns null when no daily cap is set
   * (unlimited); warm-up does not apply without a cap to ramp to.
   */
  function effectiveDailyCap(campaign) {
    const settings = campaign.settings || DEFAULT_CAMPAIGN_SETTINGS;
    if (settings.dailyCap == null) return null; // unlimited
    if (!settings.warmup || !campaign.warmupStartAt) {
      return settings.dailyCap;
    }
    const dayIndex = Math.floor((Date.now() - campaign.warmupStartAt) / 86400000);
    if (dayIndex >= 4) return settings.dailyCap;
    // Linear ramp: 5/day on day 1, reaching the full cap on day 5.
    const ramp = 5 + ((settings.dailyCap - 5) * dayIndex) / 4;
    return Math.max(5, Math.round(ramp));
  }

  /**
   * Whether the campaign can send right now. Returns
   * { ok: true } or { ok: false, reason, retryAfterMs }.
   */
  function canSendNow(campaign, now) {
    const settings = campaign.settings || DEFAULT_CAMPAIGN_SETTINGS;
    now = now || Date.now();

    if (campaign.status !== 'running') {
      return { ok: false, reason: 'not-running', retryAfterMs: 60000 };
    }

    if (campaign.cooldownUntil && now < campaign.cooldownUntil) {
      return {
        ok: false,
        reason: 'cooldown',
        retryAfterMs: campaign.cooldownUntil - now
      };
    }

    if (!isWithinActiveHours(now, settings.activeStart, settings.activeEnd)) {
      return {
        ok: false,
        reason: 'outside-active-hours',
        retryAfterMs: msUntilActiveHours(now, settings.activeStart, settings.activeEnd)
      };
    }

    // Reset counters when day/week rolls over.
    const today = dayKey(now);
    const thisWeek = weekKey(now);
    const sentToday = campaign.dayKey === today ? campaign.sentToday || 0 : 0;
    const sentThisWeek = campaign.weekKey === thisWeek ? campaign.sentThisWeek || 0 : 0;

    // Caps are optional: null means unlimited — skip the check entirely.
    const dailyCap = effectiveDailyCap(campaign);
    if (dailyCap != null && sentToday >= dailyCap) {
      return {
        ok: false,
        reason: 'daily-cap',
        retryAfterMs: msUntilActiveHours(now + 60000, settings.activeStart, settings.activeEnd) + 60000
      };
    }

    if (settings.weeklyCap != null && sentThisWeek >= settings.weeklyCap) {
      return {
        ok: false,
        reason: 'weekly-cap',
        retryAfterMs: 6 * 3600000 // re-check in 6 hours
      };
    }

    if (campaign.nextSendAt && now < campaign.nextSendAt) {
      return { ok: false, reason: 'waiting', retryAfterMs: campaign.nextSendAt - now };
    }

    return { ok: true };
  }

  /**
   * Compute the delay after a successful send: gaussian inter-message delay,
   * plus a 15–30 min session break after every 8–12 sends.
   * Returns { delayMs, takeBreak, nextBreakAt }.
   */
  function nextDelayAfterSend(campaign) {
    const settings = campaign.settings || DEFAULT_CAMPAIGN_SETTINGS;
    const delays = delaySettings(settings);
    const sessionCount = (campaign.sessionCount || 0) + 1;
    const breakAt = campaign.nextBreakAt || randInt(8, 12);

    if (sessionCount >= breakAt) {
      const breakMs = randInt(15, 30) * 60000;
      return {
        delayMs: breakMs,
        takeBreak: true,
        sessionCount: 0,
        nextBreakAt: randInt(8, 12)
      };
    }

    return {
      delayMs: gaussianDelayMs(delays.minDelaySec, delays.maxDelaySec),
      takeBreak: false,
      sessionCount,
      nextBreakAt: breakAt
    };
  }

  /**
   * Cooldown duration after a failed send: 1–2 hours.
   */
  function errorCooldownMs() {
    return randInt(60, 120) * 60000;
  }

  /**
   * Extract custom double-brace placeholders ({{company}}, {{role}}, ...)
   * from a campaign message. Returns unique keys in order of appearance.
   */
  function extractCustomPlaceholders(text) {
    const names = new Set();
    let match;
    const re = /\{\{([a-zA-Z0-9_]+)\}\}/g;
    while ((match = re.exec(String(text || ''))) !== null) {
      names.add(match[1]);
    }
    return Array.from(names);
  }

  /**
   * Apply merge fields to a campaign message.
   * {name} is auto-filled from the recipient's profile; custom {{placeholders}}
   * are filled from the recipient's user-entered per-recipient values
   * (missing values become blank). Custom placeholders are replaced FIRST so
   * that a literal {{name}} is not partially consumed by the single-brace
   * {name} replacement.
   */
  function applyMergeFields(text, recipient) {
    const fullName = recipient.name || recipient.fullName || '';
    const values = (recipient && recipient.placeholders) || {};
    return String(text || '')
      .replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, key) =>
        values[key] != null ? String(values[key]) : '')
      .replace(/\{name\}/gi, fullName);
  }

  /**
   * Extract the LinkedIn profile slug from a profile URL.
   */
  function extractProfileSlug(url) {
    if (!url) return null;
    try {
      const trimmed = String(url).trim();
      if (!trimmed) return null;
      const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const match = urlObj.pathname.match(/\/in\/([^/]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  /**
   * Parse a textarea blob of profile URLs (one per line) into recipient stubs.
   */
  function parseRecipientUrls(text) {
    const seen = new Set();
    const recipients = [];
    for (const line of String(text || '').split(/\r?\n/)) {
      const url = line.trim();
      if (!url) continue;
      const slug = extractProfileSlug(url);
      if (!slug) continue;
      if (seen.has(slug)) continue;
      seen.add(slug);
      const normalized = url.startsWith('http') ? url : `https://${url}`;
      recipients.push({ profileUrl: normalized, slug, name: slug });
    }
    return recipients;
  }

  return {
    DEFAULT_CAMPAIGN_SETTINGS,
    delaySettings,
    extractCustomPlaceholders,
    gaussianDelayMs,
    randInt,
    dayKey,
    weekKey,
    isWithinActiveHours,
    msUntilActiveHours,
    effectiveDailyCap,
    canSendNow,
    nextDelayAfterSend,
    errorCooldownMs,
    applyMergeFields,
    extractProfileSlug,
    parseRecipientUrls
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Campaign };
}
