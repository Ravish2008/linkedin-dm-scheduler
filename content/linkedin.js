/**
 * Content script for LinkedIn messaging automation.
 * Injected into https://www.linkedin.com/messaging/*
 *
 * Correct send flow (executed in order):
 * 1. Click the pencil/compose button in the messaging sidebar.
 * 2. Wait for the new-message overlay's recipient typeahead input and type the name.
 * 3. Wait for autocomplete suggestions and click the matching person.
 * 4. Wait for the message composer and type the message.
 * 5. Click the send button.
 */

(function () {
  'use strict';

  // Prevent duplicate injection in SPAs.
  if (window.__linkedinDmSchedulerInjected) return;
  window.__linkedinDmSchedulerInjected = true;

  const SELECTORS = {
    composeButton: [
      'button:has(svg use[href="#compose-medium"])',
      'button:has(svg use[href*="compose"])',
      'button svg use[href="#compose-medium"]',
      'button svg use[href*="compose"]',
      'button svg use[href*="open-in-new"]',
      'li-icon[type="compose-medium"]',
      'button[aria-label^="Compose a new message" i]',
      'button[aria-label*="New message" i]',
      'button[aria-label*="Compose" i]',
      'a[aria-label*="Compose" i]',
      'button[data-testid="compose-button"]',
      'button[data-test-icon-name="compose"]',
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
    messageInput: [
      'div.msg-form__contenteditable',
      '.msg-form__contenteditable',
      '.msg-overlay-conversation-bubble .msg-form__contenteditable',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButton: [
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
      el.getAttribute('role') === 'button' ||
      el.onclick;
    if (!isClickable) {
      el = el.closest('button, a, [role="button"]') || el;
    }

    el.scrollIntoView({ block: 'center', inline: 'center' });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    });
    el.dispatchEvent(clickEvent);
    if (typeof el.click === 'function') el.click();
  }

  /**
   * Simulate typing into a contenteditable or input element.
   * For LinkedIn's contenteditable composer we use document.execCommand so
   * the internal editor registers the input, hides the placeholder, and
   * enables the send button.
   */
  async function simulateTyping(el, text) {
    if (!el) throw new Error('Cannot type into null element');
    el.focus();
    el.click();

    if (el.isContentEditable) {
      // Select existing contents so insertText replaces them.
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      selection.removeAllRanges();
      selection.addRange(range);

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

  /**
   * STEP 1: Click the pencil/compose button to open the new-message overlay.
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
   * STEP 2: Type the recipient name into the new-message typeahead input.
   * Returns the input element so step 3 can dispatch Enter on it.
   */
  async function typeRecipientName(recipient) {
    const input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 8000);
    await simulateTyping(input, recipient);
    // Wait for LinkedIn to fetch and render suggestions before pressing Enter.
    await wait(1500);
    return input;
  }

  /**
   * STEP 3: Select an autocomplete suggestion.
   * - If a profileSlug is provided, navigate to the suggestion whose link/data
   *   contains that slug and press Enter.
   * - Otherwise press Enter to accept the first suggestion.
   * - Falls back to clicking a visible suggestion if keyboard selection fails.
   */
  async function selectRecipientSuggestion(recipient, profileSlug, input) {
    if (!input) {
      input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 2000);
    }

    // Ensure suggestions have rendered before interacting with them.
    const suggestions = await waitForSuggestions(5000);

    let target;
    if (profileSlug) {
      target = findSuggestionBySlug(suggestions, profileSlug);
    }

    if (target) {
      // Matched by profile slug: arrow-key down to the target and press Enter.
      const selectedByKeyboard = await selectSuggestionByKeyboard(input, suggestions, target);
      if (!selectedByKeyboard) {
        clickElement(target);
      }
    } else if (profileSlug) {
      // A profile slug was provided but no match was found; warn but still fall
      // back to selecting the first suggestion so the flow does not hard-fail.
      console.warn(
        `[LinkedIn DM Scheduler] No suggestion matched slug "${profileSlug}". Falling back to first result.`
      );
      dispatchEnterKey(input);
    } else {
      // No slug provided: press Enter to accept the first suggestion.
      dispatchEnterKey(input);
    }

    // Wait for the recipient pill to appear, confirming the selection.
    let pill = await waitForRecipientPill(recipient, 5000).catch(() => null);

    if (!pill) {
      // Fallback: click the first visible suggestion.
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

    // Wait for the composer to become ready now that the recipient is selected.
    await wait(800);
  }

  /**
   * Wait for suggestion option elements to appear in the DOM.
   */
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

  /**
   * Collect suggestion option elements from known selectors and from the
   * listbox referenced by the typeahead input's aria-owns/aria-controls.
   */
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

    // Prefer options that actually look like suggestions and are visible.
    const combined = [...fromSelectors, ...fromListboxes].filter((el) => isVisible(el));
    // Deduplicate by element reference.
    return Array.from(new Set(combined));
  }

  function findAnyVisibleSuggestion() {
    return getAllSuggestions()[0] || null;
  }

  /**
   * Return the suggestion element whose link or data attributes contain the
   * given LinkedIn profile slug.
   */
  function findSuggestionBySlug(suggestions, slug) {
    const lowerSlug = slug.toLowerCase();
    return (
      suggestions.find((el) => {
        // Check anchor hrefs inside the suggestion.
        const link = el.closest('a') || el.querySelector('a');
        if (link) {
          const href = (link.getAttribute('href') || '').toLowerCase();
          if (href.includes(`/in/${lowerSlug}`)) return true;
        }
        // Check data attributes and text content.
        const attrs = Array.from(el.attributes)
          .map((attr) => attr.value.toLowerCase())
          .join(' ');
        if (attrs.includes(lowerSlug)) return true;
        return el.textContent.toLowerCase().includes(lowerSlug);
      }) || null
    );
  }

  /**
   * Use ArrowDown keyboard navigation to move the selection to the target
   * suggestion, then press Enter.
   */
  async function selectSuggestionByKeyboard(input, suggestions, target) {
    const index = Array.from(suggestions).indexOf(target);
    if (index < 0) return false;

    input.focus();
    // Press ArrowDown enough times to reach the target option.
    const downCount = index + 1;
    for (let i = 0; i < downCount; i++) {
      dispatchKey(input, 'ArrowDown', 40);
      await wait(80);
    }
    dispatchEnterKey(input);
    return true;
  }

  /**
   * Dispatch a keyboard event on an element.
   */
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

  /**
   * Dispatch Enter keyboard events on an element.
   */
  function dispatchEnterKey(el) {
    dispatchKey(el, 'Enter', 13);
  }

  /**
   * Wait for a recipient pill containing the recipient name to appear.
   */
  function waitForRecipientPill(recipient, timeout = 5000) {
    return waitForElementWithText(SELECTORS.recipientPill, recipient, timeout);
  }

  /**
   * Helper: locate the suggestions menu via the typeahead's ARIA attributes.
   * Kept as a last-resort fallback.
   */
  function findSuggestionInLinkedListbox(recipient) {
    const suggestions = getAllSuggestions();
    const lower = recipient.toLowerCase();
    return (
      suggestions.find((option) =>
        option.textContent.toLowerCase().includes(lower)
      ) || null
    );
  }

  /**
   * STEP 4: Type the message into the composer.
   */
  async function typeMessage(text) {
    const input = await waitForSelector(SELECTORS.messageInput, 8000);
    await simulateTyping(input, text);
    await wait(600);
  }

  /**
   * STEP 5: Click the send button.
   */
  async function clickSend() {
    let sendBtn;
    try {
      sendBtn = await waitForSelector(SELECTORS.sendButton, 8000);
    } catch {
      sendBtn = findButtonByLabel('send message') || findButtonByLabel('send');
    }
    if (!sendBtn) {
      throw new Error('Could not find the send button');
    }
    if (sendBtn.disabled) {
      // Wait briefly in case the button is still enabling.
      await wait(1500);
      if (sendBtn.disabled) {
        throw new Error('Send button is disabled');
      }
    }

    await randomDelay(400);
    clickElement(sendBtn);
    await wait(1500);
  }

  /**
   * Send a LinkedIn DM by executing the 5-step flow in order with retries.
   */
  async function sendLinkedInMessage({ recipient, text, profileSlug }) {
    if (!recipient || !text) {
      throw new Error('Recipient and message text are required.');
    }

    let lastError;
    for (let attempt = 0; attempt < CONFIG.retryAttempts; attempt++) {
      try {
        await clickComposeButton();
        const recipientInput = await typeRecipientName(recipient);
        await selectRecipientSuggestion(recipient, profileSlug || null, recipientInput);
        await typeMessage(text);
        await clickSend();
        // Give LinkedIn time to process the send and update the UI.
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
