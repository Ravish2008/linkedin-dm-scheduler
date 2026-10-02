/**
 * Content script for LinkedIn messaging automation.
 * Injected into https://www.linkedin.com/messaging/*
 *
 * Handles:
 * - Opening the conversation with a recipient.
 * - Typing the message.
 * - Sending the message.
 * - Reporting success/failure back to the service worker.
 */

(function () {
  'use strict';

  // Prevent duplicate injection in SPAs.
  if (window.__linkedinDmSchedulerInjected) return;
  window.__linkedinDmSchedulerInjected = true;

  const SELECTORS = {
    composeButton: [
      'button:has(svg use[href="#compose-medium"])',
      'button:has(svg use[href*="open-in-new"])',
      'button svg use[href="#compose-medium"]',
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
    conversationSearchInput: [
      'input[placeholder*="Search messages" i]',
      'input[aria-label*="Search messages" i]',
      'input[aria-label*="Search" i]',
      '.msg-overlay-list-bubble-search__search-box input',
      '.msg-overlay-list-bubble-search__input',
      '#search-conversations',
      'input[placeholder*="Search" i]'
    ],
    composeSearchInput: [
      'input[aria-label*="Search by name" i]',
      'input[placeholder*="name" i]',
      'div[contenteditable="true"][aria-label*="Search" i]',
      'div[contenteditable="true"][aria-label*="name" i]',
      '.msg-connections-search__input',
      '.msg-connections-search__contenteditable',
      '.msg-overlay-list-bubble__search-recipient input',
      '.msg-overlay-list-bubble__search-recipient [contenteditable="true"]',
      '[role="combobox"] input',
      '[role="combobox"] [contenteditable="true"]'
    ],
    searchResultItems: [
      '.msg-connections-result__connection-item',
      '.msg-connections-result-list button',
      '[data-test-msg-to-selector] button',
      '[data-testid="connection-list-item"]',
      '.msg-overlay-list-bubble__content .artdeco-button',
      '.msg-overlay-list-bubble__content button',
      '[role="listbox"] button',
      '[role="option"]'
    ],
    messageInput: [
      'div.msg-form__contenteditable',
      '.msg-form__contenteditable',
      '.msg-overlay-conversation-bubble .msg-form__contenteditable',
      '.msg-overlay-conversation-bubble [contenteditable="true"]',
      'div.msg-form__contenteditable p[contenteditable="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      '[role="textbox"]'
    ],
    sendButton: [
      "button.msg-form__send-button.artdeco-button.artdeco-button--1[type='submit']",
      'button[type="submit"].msg-form__send-button',
      'button.msg-form__send-button',
      'button[aria-label*="Send" i]',
      'button[aria-label="Send message"]',
      '.msg-form__send-button'
    ],
    conversationListItems: [
      '.msg-conversation-listitem',
      '.msg-conversation-card',
      '.msg-overlay-list-bubble__content li',
      'a[href^="/messaging/thread/"]',
      '.msg-conversation-listitem__participant-names'
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
          const el = root.querySelector(selector);
          if (el && isVisible(el)) {
            resolve(el);
            return;
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
            el.textContent.toLowerCase().includes(lowerText)
          );
          if (match && isVisible(match)) {
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
      el =
        el.closest('button, a, [role="button"]') ||
        el;
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
   * Find and click the send button.
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
    await randomDelay(400);
    clickElement(sendBtn);
    await wait(1200);
  }

  /**
   * Try to find an existing conversation for the recipient in the left rail.
   */
  async function tryExistingConversation(recipient) {
    try {
      const searchInput = await waitForSelector(
        SELECTORS.conversationSearchInput,
        5000
      );
      await simulateTyping(searchInput, recipient);
      await wait(1500);

      const item = await waitForElementWithText(
        SELECTORS.conversationListItems,
        recipient,
        6000
      );
      const clickable =
        item.closest('.msg-conversation-listitem, .msg-conversation-card, li, a[href^="/messaging/thread/"]') ||
        item;
      clickElement(clickable);
      await wait(1500);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Use the compose flow to start a new conversation.
   */
  async function openConversationViaCompose(recipient) {
    let composeBtn;
    try {
      composeBtn = await waitForSelector(SELECTORS.composeButton, 6000);
    } catch {
      composeBtn = findButtonByLabel('compose') || findButtonByLabel('new message');
    }
    if (!composeBtn) {
      throw new Error('Could not find the compose/new message button');
    }
    clickElement(composeBtn);
    await wait(1500);

    const searchInput = await waitForSelector(SELECTORS.composeSearchInput, 8000);
    await simulateTyping(searchInput, recipient);
    await wait(1500);

    const resultItems = document.querySelectorAll(
      SELECTORS.searchResultItems.join(', ')
    );

    let selected;
    for (const item of resultItems) {
      if (
        item.textContent.toLowerCase().includes(recipient.toLowerCase()) ||
        item.getAttribute('aria-label')?.toLowerCase().includes(recipient.toLowerCase())
      ) {
        selected = item;
        break;
      }
    }

    if (!selected) {
      throw new Error(`No matching search results found for "${recipient}"`);
    }

    clickElement(selected);
    await wait(2000);
  }

  /**
   * Open the conversation for a recipient, falling back between strategies.
   */
  async function openConversation(recipient) {
    let lastError;
    for (let attempt = 0; attempt < CONFIG.retryAttempts; attempt++) {
      try {
        const foundExisting = await tryExistingConversation(recipient);
        if (foundExisting) return;

        await openConversationViaCompose(recipient);
        return;
      } catch (err) {
        lastError = err;
        console.warn(`[LinkedIn DM Scheduler] openConversation attempt ${attempt + 1} failed:`, err);
        await randomDelay(1500);
      }
    }
    throw lastError || new Error(`Could not open conversation with ${recipient}`);
  }

  /**
   * Type and send the message.
   */
  async function typeAndSend(text) {
    const input = await waitForSelector(SELECTORS.messageInput, 12000);
    await simulateTyping(input, text);
    await randomDelay(600);
    await clickSend();
  }

  /**
   * Send a LinkedIn DM.
   */
  async function sendLinkedInMessage({ recipient, text }) {
    if (!recipient || !text) {
      throw new Error('Recipient and message text are required.');
    }

    await openConversation(recipient);
    await typeAndSend(text);

    // Wait briefly to let LinkedIn process the send.
    await wait(1500);
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
