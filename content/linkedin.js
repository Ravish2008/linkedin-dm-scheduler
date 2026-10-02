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
   */
  async function simulateTyping(el, text) {
    if (!el) throw new Error('Cannot type into null element');
    el.focus();
    el.click();

    if (el.isContentEditable) {
      el.innerHTML = '';
      el.textContent = text;
    } else {
      el.value = text;
    }

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
   */
  async function typeRecipientName(recipient) {
    const input = await waitForSelector(SELECTORS.recipientTypeaheadInput, 8000);
    await simulateTyping(input, recipient);
    // Give LinkedIn time to fetch and render suggestions.
    await wait(1200);
  }

  /**
   * STEP 3: Select the matching person from the autocomplete dropdown.
   */
  async function selectRecipientSuggestion(recipient) {
    let suggestion;
    try {
      suggestion = await waitForElementWithText(
        SELECTORS.recipientSuggestions,
        recipient,
        8000
      );
    } catch {
      // Fallback: try to use the aria-owns/aria-controls listbox directly.
      suggestion = findSuggestionInLinkedListbox(recipient);
    }

    if (!suggestion) {
      throw new Error(`No autocomplete suggestion found for "${recipient}"`);
    }

    clickElement(suggestion);
    // Wait for the recipient pill to appear and the composer to become ready.
    await wait(1200);
  }

  /**
   * Helper: locate the suggestions menu via the typeahead's ARIA attributes.
   */
  function findSuggestionInLinkedListbox(recipient) {
    const inputs = document.querySelectorAll(
      SELECTORS.recipientTypeaheadInput.join(', ')
    );
    const lower = recipient.toLowerCase();

    for (const input of inputs) {
      const listboxIds =
        (input.getAttribute('aria-owns') || input.getAttribute('aria-controls') || '')
          .split(/\s+/)
          .filter(Boolean);
      for (const id of listboxIds) {
        const listbox = document.getElementById(id);
        if (!listbox) continue;
        const options = listbox.querySelectorAll('[role="option"], li, button');
        for (const option of options) {
          if (
            option.textContent.toLowerCase().includes(lower) &&
            isVisible(option)
          ) {
            return option;
          }
        }
      }
    }
    return null;
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
  async function sendLinkedInMessage({ recipient, text }) {
    if (!recipient || !text) {
      throw new Error('Recipient and message text are required.');
    }

    let lastError;
    for (let attempt = 0; attempt < CONFIG.retryAttempts; attempt++) {
      try {
        await clickComposeButton();
        await typeRecipientName(recipient);
        await selectRecipientSuggestion(recipient);
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
