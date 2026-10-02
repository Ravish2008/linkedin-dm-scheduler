/**
 * Content script for LinkedIn messaging automation.
 * Runs on LinkedIn pages (messaging, profiles, etc.).
 *
 * Two supported send flows:
 * 1. Profile-URL flow (preferred): when a profileUrl is provided, the background
 *    worker navigates to the profile page. This script clicks the Message button,
 *    waits for the inline conversation overlay, types the message, and sends.
 * 2. Compose/typeahead flow (fallback): when no profileUrl is provided, this
 *    script opens the new-message overlay, searches by name, selects the person,
 *    types the message, and sends.
 */

(function () {
  'use strict';

  // Prevent duplicate injection in SPAs.
  if (window.__linkedinDmSchedulerInjected) return;
  window.__linkedinDmSchedulerInjected = true;

  const SELECTORS = {
    // Profile page Message button.
    profileMessageButton: [
      'svg#send-privately-small',
      'svg use[href*="send-privately"]'
    ],
    // Compose/typeahead flow selectors.
    composeButton: [
      'button:has(svg use[href="#compose-medium"])',
      'button:has(svg use[href*="compose"])',
      'button svg use[href="#compose-medium"]',
      'button svg use[href*="compose"]',
      'li-icon[type="compose-medium"]',
      'button[aria-label^="Compose a new message" i]',
      'button[aria-label*="New message" i]',
      'button[aria-label*="Compose" i]',
      'a[aria-label*="Compose" i]',
      'button[data-testid="compose-button"]',
      '.msg-overlay-list-bubble__compose-button',
      '.msg-overlay-bubble-header__controls button',
      '.msg-overlay-bubble-header__control',
      '.msg-compose-btn button',
      '.msg-overlay-list-bubble-header button'
    ],
    recipientTypeaheadInput: [
      "input.msg-connections-typeahead__search-field[placeholder='Type a name or multiple names'][role='combobox']",
      'input.msg-connections-typeahead__search-field[role="combobox"]',
      'input.msg-connections-typeahead__search-field',
      'input[role="combobox"][placeholder*="name" i]',
      '.msg-connections-typeahead__search-field'
    ],
    recipientSuggestions: [
      '.msg-connections-typeahead__suggestion',
      '.msg-connections-typeahead__result',
      '.artdeco-typeahead__result',
      '[role="listbox"] [role="option"]',
      '.msg-connections-typeahead__dropdown [role="option"]',
      '.msg-connections-typeahead__dropdown li',
      '.artdeco-typeahead__dropdown [role="option"]'
    ],
    recipientPill: [
      '.msg-connections-typeahead__recipient-pill',
      '.msg-connections-typeahead__selected-recipient',
      '.msg-connections-typeahead__pill',
      '.artdeco-pill',
      '[data-testid="recipient-pill"]'
    ],
    // Message composer (used by both flows once the composer is open).
    messageInput: [
      '.msg-overlay-conversation-bubble div.msg-form__contenteditable[contenteditable="true"]',
      'div.msg-form__contenteditable[contenteditable="true"][aria-label*="Write a message" i]',
      'div.msg-form__contenteditable[contenteditable="true"][aria-label*="Write a message"]',
      'div.msg-form__contenteditable[contenteditable="true"]',
      '.msg-form__contenteditable',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    overlayContainer: [
      '.msg-overlay-conversation-bubble',
      '.msg-convo-wrapper',
      '.msg-overlay'
    ],
    sendButton: [
      '.msg-overlay-conversation-bubble button.msg-form__send-button[type="submit"]',
      "button.msg-form__send-button[type='submit']",
      'button[type="submit"].msg-form__send-button',
      'button.msg-form__send-button',
      'button[aria-label*="Send" i]',
      'button[aria-label="Send message"]',
      '.msg-form__send-button'
    ]
  };

  const CONFIG = {
    retryAttempts: 3,
    baseDelay: 600,
    maxWait: 12000,
    typingDelay: 25
  };

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelay(base = CONFIG.baseDelay) {
    return wait(base + Math.floor(Math.random() * 400));
  }

  /**
   * Try to find one of the provided selectors within a timeout.
   */
  async function waitForSelector(selectors, timeout = CONFIG.maxWait, root = document) {
    const selectorsArray = Array.isArray(selectors) ? selectors : [selectors];
    const start = Date.now();

    return new Promise((resolve, reject) => {
      function search() {
        for (const selector of selectorsArray) {
          try {
            const el = root.querySelector(selector);
            if (el && isVisible(el)) {
              resolve(el);
              return;
            }
          } catch (err) {
            // Invalid :has() selector in very old browsers; ignore and try next.
          }
        }
        if (Date.now() - start > timeout) {
          reject(new Error(`Timed out waiting for selectors: ${selectorsArray.join(', ')}`));
          return;
        }
        setTimeout(search, 200);
      }
      search();
    });
  }

  /**
   * Wait until an element containing specific text appears.
   */
  async function waitForElementWithText(selectors, text, timeout = CONFIG.maxWait) {
    const selectorsArray = Array.isArray(selectors) ? selectors : [selectors];
    const start = Date.now();
    const lowerText = text.toLowerCase();

    return new Promise((resolve, reject) => {
      function search() {
        for (const selector of selectorsArray) {
          const elements = Array.from(document.querySelectorAll(selector));
          const match = elements.find((el) =>
            el.textContent.toLowerCase().includes(lowerText) && isVisible(el)
          );
          if (match) {
            resolve(match);
            return;
          }
        }
        if (Date.now() - start > timeout) {
          reject(new Error(`Timed out waiting for text "${text}"`));
          return;
        }
        setTimeout(search, 300);
      }
      search();
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return true;
    return !!(el.offsetParent !== null);
  }

  /**
   * Find a clickable element (button, link, or labelled wrapper) for a given label substring.
   */
  function findButtonByLabel(substring) {
    const lower = substring.toLowerCase();
    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return buttons.find((el) => {
      const label = (el.getAttribute('aria-label') || el.textContent || '').toLowerCase();
      return label.includes(lower) && isVisible(el);
    });
  }

  function clickElement(el) {
    if (!el) throw new Error('Cannot click null element');

    // If we hit an icon/svg/custom element, walk up to the real control.
    const clickableTag = /^(button|a)$/i;
    const isClickable =
      clickableTag.test(el.tagName) ||
      el.tagName.toLowerCase() === 'span' ||
      el.getAttribute('role') === 'button' ||
      el.onclick;
    if (!isClickable) {
      el = el.closest('button, a, span, [role="button"]') || el;
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    const events = ['pointerdown', 'mousedown', 'click', 'pointerup', 'mouseup'];
    for (const type of events) {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window
      });
      el.dispatchEvent(event);
    }
    if (typeof el.click === 'function') {
      try {
        el.click();
      } catch (err) {
        // Some elements throw when programmatically clicked; ignore.
      }
    }
  }

  /**
   * Simulate typing into a contenteditable or input element.
   * For LinkedIn's contenteditable composer we use document.execCommand so
   * the internal editor registers the input, hides the placeholder, and
   * enables the send button.
   */
  async function simulateTyping(el, text) {
    if (!el) throw new Error('Cannot type into null element');

    // Ensure the composer is in view before interacting with it.
    el.scrollIntoView({ block: 'center', inline: 'center' });

    if (el.isContentEditable) {
      // LinkedIn's composer is a contenteditable div that often contains
      // <p><br></p>. Clicking/focusing the inner <p> is more reliable than
      // the outer div, which may let the overlay intercept events.
      const innerParagraph = el.querySelector('p') || el;
      clickElement(innerParagraph);
      innerParagraph.focus();
      el.focus();

      // Place the cursor at the start of the editable paragraph.
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(innerParagraph, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);

      // Let the editor register focus/selection before inserting text.
      await wait(500);

      const inserted = document.execCommand('insertText', false, text);
      if (!inserted) {
        // Fallback for environments where execCommand is unavailable.
        el.textContent = text;
      }

      // Safety-net events to ensure LinkedIn updates its state.
      el.dispatchEvent(
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: text
        })
      );
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      el.dispatchEvent(
        new KeyboardEvent('keyup', { bubbles: true, cancelable: true })
      );
    } else {
      el.focus();
      el.click();
      el.value = text;

      const events = ['focus', 'input', 'change', 'keyup'];
      for (const type of events) {
        let event;
        if (type === 'input') {
          event = new InputEvent('input', {
            bubbles: true,
            cancelable: true,
            inputType: 'insertText',
            data: text
          });
        } else {
          event = new Event(type, { bubbles: true, cancelable: true });
        }
        el.dispatchEvent(event);
      }
    }

    // Mimic human typing speed for longer messages.
    if (text.length > 50) {
      await wait(Math.min(text.length * CONFIG.typingDelay, 1200));
    }
  }

  // ---------------------------------------------------------------------------
  // PROFILE-URL FLOW
  // ---------------------------------------------------------------------------

  /**
   * Click the Message button on a LinkedIn profile page.
   */
  async function clickProfileMessageButton() {
    // If the overlay is already active, do not click again (avoids closing it on retries).
    if (isProfileOverlayOpen()) {
      return;
    }

    // Profile pages render the action bar dynamically; give it time to appear.
    await wait(4000);

    let messageBtn = findProfileMessageButton();

    if (!messageBtn) {
      // LinkedIn sometimes lazily mounts the button; poll briefly.
      const start = Date.now();
      while (!messageBtn && Date.now() - start < 8000) {
        await wait(500);
        messageBtn = findProfileMessageButton();
      }
    }

    if (!messageBtn) {
      throw new Error('Could not find the Message button on the profile page');
    }

    clickElement(messageBtn);
    // Wait for the inline message overlay and its composer to fully render.
    await wait(5000);
  }

  function isProfileOverlayOpen() {
    return !!(
      document.querySelector('.msg-overlay-conversation-bubble--is-active') ||
      document.querySelector('.msg-overlay-conversation-bubble--active') ||
      document.querySelector('.msg-overlay-conversation-bubble .msg-form__contenteditable[contenteditable="true"]')
    );
  }

  function findProfileMessageButton() {
    // Primary: the clickable span wraps svg#send-privately-small.
    const svg = document.querySelector('svg#send-privately-small');
    if (svg && isVisible(svg)) {
      let parent = svg.parentElement;
      while (parent && parent !== document.body) {
        if (parent.tagName.toLowerCase() === 'span' || parent.tagName.toLowerCase() === 'button') {
          if (isVisible(parent)) return parent;
        }
        parent = parent.parentElement;
      }
    }

    // Fallback 1: any element whose trimmed text is exactly "Message".
    const candidates = Array.from(document.querySelectorAll('span, button, a, [role="button"]'));
    const exact = candidates.find(
      (el) => el.textContent.trim() === 'Message' && isVisible(el)
    );
    if (exact) return exact;

    // Fallback 2: any visible element containing "Message" near the top of the profile.
    const fuzzy = candidates.find(
      (el) => /\bMessage\b/.test(el.textContent) && isVisible(el)
    );
    return fuzzy || null;
  }

  // ---------------------------------------------------------------------------
  // COMPOSE / TYPEAHEAD FLOW (fallback when no profileUrl)
  // ---------------------------------------------------------------------------

  /**
   * STEP 1 (fallback): Click the pencil/compose button to open the new-message overlay.
   */
  async function clickComposeButton() {
    // If the overlay is already open, do not click compose again (avoids closing it).
    const alreadyOpen = await hasVisibleRecipientInput();
    if (alreadyOpen) return;

    let composeBtn;
    try {
      composeBtn = await waitForSelector(SELECTORS.composeButton, 8000);
    } catch {
      composeBtn = findButtonByLabel('compose') || findButtonByLabel('new message');
    }
    if (!composeBtn) {
      throw new Error('Could not find the compose/new message (pencil) button');
    }

    clickElement(composeBtn);
    // Wait for the overlay animation and the typeahead input to appear.
    await wait(1200);
  }

  /**
   * Returns true if the recipient typeahead input is already visible.
   */
  async function hasVisibleRecipientInput() {
    try {
      const input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 1500);
      return !!input;
    } catch {
      return false;
    }
  }

  /**
   * STEP 2 (fallback): Type the recipient name into the new-message typeahead input.
   */
  async function typeRecipientName(recipient) {
    const input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 8000);
    await simulateTyping(input, recipient);
    // Wait for LinkedIn to fetch and render suggestions before pressing Enter.
    await wait(1500);
    return input;
  }

  /**
   * STEP 3 (fallback): Select an autocomplete suggestion.
   * - If a profileSlug is provided, navigate to the suggestion whose link/data
   *   contains that slug and press Enter.
   * - Otherwise press Enter to accept the first suggestion.
   */
  async function selectRecipientSuggestion(recipient, profileSlug, input) {
    if (!input) {
      input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 2000);
    }

    const suggestions = await waitForSuggestions(5000);

    let target;
    if (profileSlug) {
      target = findSuggestionBySlug(suggestions, profileSlug);
    }

    if (target) {
      const selectedByKeyboard = await selectSuggestionByKeyboard(input, suggestions, target);
      if (!selectedByKeyboard) {
        clickElement(target);
      }
    } else if (profileSlug) {
      console.warn(
        `[LinkedIn DM Scheduler] No suggestion matched slug "${profileSlug}". Falling back to first result.`
      );
      dispatchEnterKey(input);
    } else {
      dispatchEnterKey(input);
    }

    // Wait for the recipient pill to appear, confirming the selection.
    let pill = await waitForRecipientPill(recipient, 5000).catch(() => null);

    if (!pill) {
      const fallback = suggestions[0] || findAnyVisibleSuggestion();
      if (!fallback) {
        throw new Error(`No autocomplete suggestions available for "${recipient}"`);
      }
      clickElement(fallback);
      pill = await waitForRecipientPill(recipient, 5000).catch(() => null);
      if (!pill) {
        throw new Error(`Recipient pill did not appear after selecting "${recipient}"`);
      }
    }

    await wait(800);
  }

  async function waitForSuggestions(timeout = 5000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      function search() {
        const suggestions = getAllSuggestions();
        if (suggestions.length > 0) {
          resolve(suggestions);
          return;
        }
        if (Date.now() - start > timeout) {
          reject(new Error('Timed out waiting for autocomplete suggestions'));
          return;
        }
        setTimeout(search, 200);
      }
      search();
    });
  }

  function getAllSuggestions() {
    const fromSelectors = Array.from(
      document.querySelectorAll(SELECTORS.recipientSuggestions.join(', '))
    );

    const fromListboxes = [];
    const inputs = document.querySelectorAll(SELECTORS.recipientTypeaheadInput.join(', '));
    for (const input of inputs) {
      const listboxIds = (input.getAttribute('aria-owns') || input.getAttribute('aria-controls') || '')
        .split(/\s+/)
        .filter(Boolean);
      for (const id of listboxIds) {
        const listbox = document.getElementById(id);
        if (!listbox) continue;
        listbox.querySelectorAll('[role="option"], li, button').forEach((el) => {
          if (isVisible(el)) fromListboxes.push(el);
        });
      }
    }

    const combined = [...fromSelectors, ...fromListboxes].filter((el) => isVisible(el));
    return Array.from(new Set(combined));
  }

  function findAnyVisibleSuggestion() {
    return getAllSuggestions()[0] || null;
  }

  function findSuggestionBySlug(suggestions, slug) {
    const lowerSlug = slug.toLowerCase();
    return (
      suggestions.find((el) => {
        const link = el.closest('a') || el.querySelector('a');
        if (link) {
          const href = (link.getAttribute('href') || '').toLowerCase();
          if (href.includes(`/in/${lowerSlug}`)) return true;
        }
        const attrs = Array.from(el.attributes)
          .map((attr) => attr.value.toLowerCase())
          .join(' ');
        if (attrs.includes(lowerSlug)) return true;
        return el.textContent.toLowerCase().includes(lowerSlug);
      }) || null
    );
  }

  async function selectSuggestionByKeyboard(input, suggestions, target) {
    const index = Array.from(suggestions).indexOf(target);
    if (index < 0) return false;

    input.focus();
    const downCount = index + 1;
    for (let i = 0; i < downCount; i++) {
      dispatchKey(input, 'ArrowDown', 40);
      await wait(80);
    }
    dispatchEnterKey(input);
    return true;
  }

  function dispatchKey(el, key, keyCode) {
    const events = ['keydown', 'keypress', 'keyup'];
    for (const type of events) {
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key,
          code: key,
          keyCode,
          which: keyCode,
          bubbles: true,
          cancelable: true
        })
      );
    }
  }

  function dispatchEnterKey(el) {
    dispatchKey(el, 'Enter', 13);
  }

  function waitForRecipientPill(recipient, timeout = 5000) {
    return waitForElementWithText(SELECTORS.recipientPill, recipient, timeout);
  }

  // ---------------------------------------------------------------------------
  // SHARED COMPOSER STEPS
  // ---------------------------------------------------------------------------

  function findComposerInOverlay() {
    // Search inside the overlay container first.
    for (const containerSelector of SELECTORS.overlayContainer) {
      const container = document.querySelector(containerSelector);
      if (!container) continue;
      for (const inputSelector of SELECTORS.messageInput) {
        const parts = inputSelector.split(' ');
        // If the selector already scopes inside the overlay, query globally.
        const selector = parts[0].startsWith('.msg-overlay-conversation-bubble')
          ? inputSelector
          : `${containerSelector} ${inputSelector}`;
        try {
          const el = document.querySelector(selector);
          if (el) return el;
        } catch {
          // Invalid selector combination; skip.
        }
      }
    }

    // Direct global fallback without requiring a container.
    const direct = document.querySelector(
      'div.msg-form__contenteditable[contenteditable="true"]'
    );
    if (direct) return direct;

    return document.querySelector('div[contenteditable="true"][role="textbox"]') || null;
  }

  /**
   * Wait for the message composer to appear.
   * - Polls up to 15 seconds.
   * - First looks inside any visible overlay bubble.
   * - Falls back to the broader selector list.
   */
  async function waitForComposer(timeout = 15000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      function search() {
        const overlayComposer = findComposerInOverlay();
        if (overlayComposer) {
          resolve(overlayComposer);
          return;
        }

        const broad = waitForSelectorSync(SELECTORS.messageInput);
        if (broad) {
          resolve(broad);
          return;
        }

        if (Date.now() - start > timeout) {
          reject(new Error('Timed out waiting for the message composer'));
          return;
        }
        setTimeout(search, 500);
      }
      search();
    });
  }

  function waitForSelectorSync(selectors) {
    const arr = Array.isArray(selectors) ? selectors : [selectors];
    for (const selector of arr) {
      try {
        const el = document.querySelector(selector);
        if (el) return el;
      } catch {
        // invalid selector
      }
    }
    return null;
  }

  /**
   * Type the message into the composer.
   */
  async function typeMessage(text) {
    const input = await waitForComposer(15000);
    await simulateTyping(input, text);
    await wait(600);
  }

  /**
   * Click the send button once it is enabled.
   */
  async function clickSend() {
    let sendBtn;
    try {
      sendBtn = await waitForSelector(SELECTORS.sendButton, 15000);
    } catch {
      sendBtn = findButtonByLabel('send message') || findButtonByLabel('send');
    }
    if (!sendBtn) {
      throw new Error('Could not find the send button');
    }

    // Wait until LinkedIn enables the button.
    const enabled = await waitForEnabled(sendBtn, 5000);
    if (!enabled) {
      throw new Error('Send button remained disabled');
    }

    await randomDelay(400);
    clickElement(sendBtn);
    await wait(1500);
  }

  /**
   * Wait for an element to become enabled (no disabled attribute/property).
   */
  async function waitForEnabled(el, timeout = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (!el.disabled && !el.hasAttribute('disabled')) {
        return true;
      }
      await wait(250);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // ENTRY POINT
  // ---------------------------------------------------------------------------

  /**
   * Send a LinkedIn DM.
   * Uses the profile-URL flow when profileUrl is provided; otherwise falls back
   * to the compose/typeahead flow.
   */
  async function sendLinkedInMessage({ recipient, text, profileUrl, profileSlug }) {
    if (!recipient || !text) {
      throw new Error('Recipient and message text are required.');
    }

    let lastError;
    for (let attempt = 0; attempt < CONFIG.retryAttempts; attempt++) {
      try {
        if (profileUrl) {
          await clickProfileMessageButton();
        } else {
          await clickComposeButton();
          const recipientInput = await typeRecipientName(recipient);
          await selectRecipientSuggestion(recipient, profileSlug || null, recipientInput);
        }

        await typeMessage(text);
        await clickSend();
        await wait(1500);
        return;
      } catch (err) {
        lastError = err;
        console.warn(
          `[LinkedIn DM Scheduler] send attempt ${attempt + 1} failed:`,
          err.message
        );
        await randomDelay(1500);
      }
    }

    throw lastError || new Error(`Could not send message to ${recipient}`);
  }

  /**
   * Extract connection names from the visible conversation list.
   * Used for contact autocomplete in the popup.
   */
  function extractConnections() {
    const names = new Set();
    const selectors = [
      '.msg-conversation-listitem__participant-names',
      '.msg-conversation-card__participant-names',
      '.msg-conversation-listitem__title',
      '.msg-conversation-card__title',
      '.msg-overlay-list-bubble__content .msg-conversation-card__participant-names'
    ].join(', ');
    document.querySelectorAll(selectors).forEach((el) => {
      const text = el.textContent.trim().split('\n')[0].trim();
      if (text) names.add(text);
    });
    return Array.from(names);
  }

  // Listen for commands from the popup / background service worker.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'sendLinkedInMessage') {
      sendLinkedInMessage(request.payload)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      return true; // async response
    }

    if (request.action === 'getConnections') {
      const names = extractConnections();
      sendResponse({ success: true, connections: names });
      return false;
    }
  });
})();
