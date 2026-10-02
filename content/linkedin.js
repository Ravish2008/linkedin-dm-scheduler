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
      'button[aria-label^="Compose a new message"]',
      '.msg-compose-btn button',
      'button[data-test-icon-name="compose"]',
      '.msg-overlay-bubble-header__left-actions button'
    ],
    conversationSearchInput: [
      'input[placeholder*="Search messages"]',
      'input[aria-label*="Search messages"]',
      '.msg-overlay-list-bubble-search__search-box input',
      '#search-conversations'
    ],
    composeSearchInput: [
      'input[placeholder*="name"]',
      'input[aria-label*="Search"]',
      '.msg-connections-search__input',
      '.msg-overlay-list-bubble-search__search-box input'
    ],
    searchResultItems: [
      '.msg-connections-result-list button',
      '[data-test-msg-to-selector] button',
      '.msg-connections-result__connection-item button',
      '.msg-overlay-list-bubble__content .artdeco-button'
    ],
    messageInput: [
      '.msg-form__contenteditable',
      '.msg-overlay-conversation-bubble .msg-form__contenteditable',
      '[contenteditable="true"][role="textbox"]'
    ],
    sendButton: [
      'button[type="submit"].msg-form__send-button',
      'button.msg-form__send-button',
      'button[aria-label="Send message"]'
    ],
    conversationListItems: [
      '.msg-conversation-listitem',
      '.msg-overlay-list-bubble__content li'
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
    return !!(el.offsetParent !== null);
  }

  function clickElement(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const clickEvent = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      view: window
    });
    el.dispatchEvent(clickEvent);
    el.click();
  }

  /**
   * Simulate typing into a contenteditable or input element.
   */
  async function simulateTyping(el, text) {
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
      const event = new Event(type, { bubbles: true, cancelable: true });
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
    const sendBtn = await waitForSelector(SELECTORS.sendButton, 8000);
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
      await wait(1200);

      const item = await waitForElementWithText(
        SELECTORS.conversationListItems,
        recipient,
        6000
      );
      clickElement(item);
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
    const composeBtn = await waitForSelector(SELECTORS.composeButton, 8000);
    clickElement(composeBtn);
    await wait(1200);

    const searchInput = await waitForSelector(SELECTORS.composeSearchInput, 8000);
    await simulateTyping(searchInput, recipient);
    await wait(1200);

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

    if (!selected && resultItems.length > 0) {
      selected = resultItems[0];
    }

    if (!selected) {
      throw new Error(`No search results found for "${recipient}"`);
    }

    clickElement(selected);
    await wait(1500);
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
    document
      .querySelectorAll('.msg-conversation-listitem__participant-names, .msg-conversation-card__participant-names')
      .forEach((el) => {
        const text = el.textContent.trim();
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
