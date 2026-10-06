/**
 * Content script for LinkedIn messaging automation.
 * Runs on the LinkedIn messaging page (linkedin.com/messaging/).
 *
 * Send flow: open the new-message overlay via the compose (pencil) button,
 * search for the recipient by name in the typeahead, select the match
 * (optionally disambiguated by profile slug), type the message, and send.
 */

(function () {
  'use strict';

  // Prevent duplicate injection in SPAs.
  if (window.__linkedinDmSchedulerInjected) return;
  window.__linkedinDmSchedulerInjected = true;

  const SELECTORS = {
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
      await fillContentEditableComposer(el, text);
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

  /**
   * Executes a string of JS in the page's MAIN world by injecting a <script> tag.
   * LinkedIn's Ember/Glimmer handlers live there, so focus/click/execCommand only
   * activate the composer when run in that context.
   */
  function executeInMainWorld(fn, arg) {
    return new Promise((resolve) => {
      const callbackName = '__ldms_cb_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const script = document.createElement('script');
      script.setAttribute('data-linkedin-dm-scheduler', 'true');

      // Serialize the function and its argument. JSON.stringify safely escapes
      // quotes, newlines, backslashes, and other special characters in the message.
      const fnSource = fn.toString();
      const argJson = JSON.stringify(arg);
      script.textContent = `
        (function() {
          var callbackName = ${JSON.stringify(callbackName)};
          var done = function(result) {
            try {
              window[callbackName](result);
            } catch (e) {
              // If the callback is gone, nothing to do.
            }
          };
          try {
            (${fnSource})(${argJson}, done);
          } catch (err) {
            done({ success: false, error: String(err && err.message || err) });
          }
        })();
      `;

      let resolved = false;
      window[callbackName] = (result) => {
        if (resolved) return;
        resolved = true;
        try {
          delete window[callbackName];
        } catch {
          window[callbackName] = undefined;
        }
        resolve(result);
        try {
          script.remove();
        } catch {
          // ignore
        }
      };

      // Failsafe: resolve if the script never reports back (e.g. CSP blocks it).
      setTimeout(() => {
        if (resolved) return;
        resolved = true;
        try {
          delete window[callbackName];
        } catch {
          window[callbackName] = undefined;
        }
        resolve({ success: false, error: 'Main-world script did not respond' });
        try {
          script.remove();
        } catch {
          // ignore
        }
      }, 5000);

      const root = document.documentElement || document.head || document.body;
      if (root) {
        root.appendChild(script);
      } else {
        resolve({ success: false, error: 'No document root available' });
      }
    });
  }

  /**
   * Fills LinkedIn's contenteditable composer. Runs the interaction in the page's
   * main world first (so Ember/Glimmer handlers fire), then falls back to the
   * isolated-world approach if injection fails or is blocked.
   */
  async function fillContentEditableComposer(el, text) {
    // Approach 1: inject into the main world where LinkedIn's JS lives.
    const mainWorldResult = await fillComposerInMainWorld(text);
    if (mainWorldResult && mainWorldResult.success) {
      dispatchComposerEvents(el, text);
      return;
    }

    // Approach 2: isolated-world fallback.
    await fillComposerInIsolatedWorld(el, text);
  }

  function fillComposerInMainWorld(text) {
    function mainWorldFill(message, done) {
      const el = document.querySelector('div.msg-form__contenteditable[contenteditable="true"]');
      if (!el) {
        done({ success: false, error: 'Composer not found in main world' });
        return;
      }

      el.focus();
      el.click();

      const p = el.querySelector('p');
      if (p) {
        p.focus();
        p.click();
      }

      const target = p || el;
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(target);
      selection.removeAllRanges();
      selection.addRange(range);

      document.execCommand('selectAll', false, null);
      const inserted = document.execCommand('insertText', false, message);

      el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true }));

      const hasText = (el.textContent || '').trim().length > 0;
      if (inserted || hasText) {
        done({ success: true, hasText });
      } else {
        done({ success: false, error: 'insertText failed and no text present' });
      }
    }

    return executeInMainWorld(mainWorldFill, text);
  }

  async function fillComposerInIsolatedWorld(el, text) {
    const paragraph = el.querySelector('p') || el;

    el.focus();
    paragraph.focus();
    await wait(300);

    const selection = window.getSelection();
    const range = document.createRange();
    if (paragraph.firstChild) {
      range.setStart(paragraph.firstChild, 0);
    } else {
      range.setStart(paragraph, 0);
    }
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    await wait(300);

    document.execCommand('selectAll', false, null);
    await wait(100);
    const inserted = document.execCommand('insertText', false, text);

    if (!inserted || !hasRealText(el)) {
      el.innerHTML = `<p>${escapeHtml(text)}</p>`;
    }

    await nudgeComposerState(el);
    dispatchComposerEvents(el, text);
  }

  function hasRealText(el) {
    return (el.textContent || '').trim().length > 0;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  async function nudgeComposerState(el) {
    await wait(300);
    el.focus();
    const paragraph = el.querySelector('p') || el;
    paragraph.focus();

    const events = [
      new Event('focus', { bubbles: true }),
      new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }),
      new KeyboardEvent('keypress', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }),
      new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }),
      new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }),
      new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }),
      new KeyboardEvent('keypress', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true }),
      new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }),
      new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', keyCode: 8, bubbles: true })
    ];
    for (const event of events) {
      el.dispatchEvent(event);
      paragraph.dispatchEvent(event);
    }
  }

  function dispatchComposerEvents(el, text) {
    const events = [
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }),
      new Event('input', { bubbles: true, cancelable: true }),
      new Event('change', { bubbles: true, cancelable: true }),
      new KeyboardEvent('keyup', { bubbles: true, cancelable: true }),
      new Event('compositionend', { bubbles: true, cancelable: true })
    ];
    for (const event of events) {
      el.dispatchEvent(event);
    }
  }

  // ---------------------------------------------------------------------------
  // COMPOSE / TYPEAHEAD FLOW (messaging page)
  // ---------------------------------------------------------------------------

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
    console.log('[LDMS] findComposerInOverlay start');
    const allEditable = document.querySelectorAll('[contenteditable]');
    const msgEditable = document.querySelectorAll('div.msg-form__contenteditable');
    const bubbles = document.querySelectorAll('.msg-overlay-conversation-bubble');
    console.log(
      `[LDMS] contenteditable count=${allEditable.length}, msg-form__contenteditable count=${msgEditable.length}, bubbles count=${bubbles.length}`
    );

    for (let i = 0; i < allEditable.length; i++) {
      const el = allEditable[i];
      const parentClass = el.parentElement ? el.parentElement.className : 'none';
      console.log(
        `[LDMS] contenteditable[${i}] tag=${el.tagName}, className=${el.className}, parentClass=${parentClass}, outerHTML=${(el.outerHTML || '').slice(0, 200)}`
      );
    }

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
          if (el) {
            console.log('[LDMS] found composer via overlay selector:', selector);
            return el;
          }
        } catch {
          // Invalid selector combination; skip.
        }
      }
    }

    // Try querying directly inside each overlay bubble.
    for (const bubble of bubbles) {
      try {
        const el = bubble.querySelector('div.msg-form__contenteditable[contenteditable="true"]');
        if (el) {
          console.log('[LDMS] found composer inside overlay bubble');
          return el;
        }
      } catch {
        // ignore
      }
    }

    // Direct global fallback without requiring a container.
    const direct = document.querySelector(
      'div.msg-form__contenteditable[contenteditable="true"]'
    );
    if (direct) {
      console.log('[LDMS] found composer via direct global selector');
      return direct;
    }

    const fallback = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (fallback) {
      console.log('[LDMS] found composer via role=textbox fallback');
    }
    return fallback || null;
  }

  /**
   * Wait for the message composer to appear.
   * - Polls up to 15 seconds.
   * - First looks inside any visible overlay bubble.
   * - Falls back to the broader selector list and cross-origin iframes.
   */
  async function waitForComposer(timeout = 15000) {
    console.log('[LDMS] waitForComposer start');
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
          console.log('[LDMS] found composer via broad selector list');
          resolve(broad);
          return;
        }

        const iframeComposer = findComposerInIframes();
        if (iframeComposer) {
          console.log('[LDMS] found composer inside an iframe');
          resolve(iframeComposer);
          return;
        }

        if (Date.now() - start > timeout) {
          console.error('[LDMS] timed out waiting for composer');
          reject(new Error('Timed out waiting for the message composer'));
          return;
        }
        setTimeout(search, 500);
      }
      search();
    });
  }

  function findComposerInIframes() {
    const iframes = document.querySelectorAll('iframe');
    for (const iframe of iframes) {
      try {
        const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
        const el = iframeDoc.querySelector('div.msg-form__contenteditable[contenteditable="true"]');
        if (el) return el;
        const fallback = iframeDoc.querySelector('[contenteditable="true"]');
        if (fallback) return fallback;
      } catch {
        // Cross-origin or inaccessible iframe; skip.
      }
    }
    return null;
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
   * - When composePrefilled is true (compose URL with profileUrn), the
   *   recipient is already selected; just type and send.
   * - Otherwise use the typeahead flow: pencil icon → search by name →
   *   select suggestion → type → send. profileSlug disambiguates duplicates.
   */
  async function sendLinkedInMessage(payload) {
    const { recipient, text, profileSlug, composePrefilled } = payload;

    console.log(
      '[LDMS] sendLinkedInMessage payload:',
      JSON.stringify({
        recipient,
        textLength: text ? text.length : 0,
        profileSlug: profileSlug || null,
        composePrefilled: composePrefilled === true,
        href: window.location.href
      })
    );

    if (!recipient || !text) {
      throw new Error('Recipient and message text are required.');
    }

    // Safety net: if we're on a compose URL with a profileUrn, the recipient
    // is already pre-filled regardless of what the payload flag says.
    const isComposeUrl =
      window.location.href.includes('/messaging/compose') &&
      window.location.href.includes('profileUrn');
    const usePrefilledFlow = composePrefilled === true || isComposeUrl;

    if (usePrefilledFlow) {
      console.log('[LDMS] using pre-filled compose flow');
    }

    let lastError;
    for (let attempt = 0; attempt < CONFIG.retryAttempts; attempt++) {
      try {
        if (usePrefilledFlow) {
          // Compose URL flow: recipient pre-filled via profileUrn.
          await typeMessage(text);
          await clickSend();
        } else {
          await clickComposeButton();
          const recipientInput = await typeRecipientName(recipient);
          await selectRecipientSuggestion(recipient, profileSlug || null, recipientInput);

          await typeMessage(text);
          await clickSend();
        }
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
   * Extracts the internal LinkedIn profile ID (e.g. ACoAADj7MEIBY...) from a
   * profile page. Used to build the direct compose URL.
   */
  function extractProfileIdFromPage() {
    // 1. Message button href containing a profileUrn parameter.
    //    LinkedIn usually URL-encodes the URN (urn%3Ali%3Afsd_profile%3A...),
    //    so decode the href before matching.
    const links = document.querySelectorAll(
      'a[href*="profileUrn"], a[href*="fsd_profile"], a[href*="messaging/compose"]'
    );
    for (const link of links) {
      const rawHref = link.getAttribute('href') || '';
      let href = rawHref;
      try {
        href = decodeURIComponent(rawHref);
      } catch {
        // Malformed encoding; keep the raw href.
      }
      const match = href.match(/profileUrn=urn:li:fsd_profile:([A-Za-z0-9_-]+)/);
      if (match) return match[1];
    }

    // 2. Search the full page markup, both literal and URL-encoded forms.
    //    Profile data lives in inline scripts and <code> JSON blocks.
    const html = document.documentElement.innerHTML || '';
    const sources = [html];
    try {
      sources.push(decodeURIComponent(html));
    } catch {
      // Not encoded or malformed; the literal form is enough.
    }

    // Require a realistic ID length to avoid matching partial/other entities.
    const patterns = [
      /urn:li:fsd_profile:([A-Za-z0-9_-]{10,})/,
      /urn:li:fs_mini_profile:([A-Za-z0-9_-]{10,})/
    ];

    for (const source of sources) {
      for (const pattern of patterns) {
        const match = source.match(pattern);
        if (match) return match[1];
      }
    }

    return null;
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

  // ---------------------------------------------------------------------------
  // Company extraction for campaign merge fields.
  //
  // LinkedIn profile pages render the experience section LAZILY (only once it
  // scrolls into view), and the legacy selectors this code used before
  // (.pv-top-card--experience-list, [data-section="currentPositionsDetails"])
  // are dead on the modern DOM. The reliable, non-lazy sources are the
  // top-card headline ("Title at Company") and the <meta name="description">
  // tag, so those run first.
  // ---------------------------------------------------------------------------

  /**
   * Normalize a raw company string: strip employment-type suffixes
   * ("Google · Full-time" -> "Google"), trailing pipes, and reject noise.
   */
  function cleanCompanyName(raw) {
    if (!raw) return null;
    let s = String(raw).split('\n')[0].replace(/\s+/g, ' ').trim();
    // "Google · Full-time" -> "Google"
    s = s.replace(/\s*·\s*(Full-time|Part-time|Contract|Freelance|Internship|Self-employed|Seasonal|Apprenticeship|Temporary|Volunteer)\b.*$/i, '').trim();
    // "Google | Ex-Meta" -> "Google"
    s = s.split('|')[0].trim();
    if (s.length < 2 || s.length > 80) return null;
    return s;
  }

  /** Strategy 1: top-card headline, usually "Title at Company". */
  function companyFromHeadline() {
    const el = document.querySelector('.text-body-medium.break-words') ||
      document.querySelector('div.pv-text-details__left-panel .text-body-medium');
    const headline = el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
    if (!headline) return null;
    const m = headline.match(/\s+at\s+(.+)$/i) || headline.match(/\s+@\s+(.+)$/);
    return m ? cleanCompanyName(m[1]) : null;
  }

  /** Strategy 2: top-card "current company" link / aria-label. */
  function companyFromTopCard() {
    const labelled = document.querySelector('[aria-label*="Current company"]');
    if (labelled) {
      const m = (labelled.getAttribute('aria-label') || '').match(/Current company:\s*(.+)/i);
      if (m && m[1]) return cleanCompanyName(m[1]);
    }
    const link = document.querySelector('.pv-text-details__right-panel a[href*="/company/"]') ||
      document.querySelector('.pv-top-card--experience-list a[href*="/company/"]') ||
      document.querySelector('[data-section="currentPositionsDetails"] a');
    if (link) return cleanCompanyName(link.textContent);
    return null;
  }

  /**
   * Strategy 3: experience section first entry (modern DOM). Only present
   * when the section has been rendered (lazy-load), so this is opportunistic.
   * Ungrouped entries put "Company · Type" in a .t-14 subtitle; grouped
   * entries (several roles, one company) use the bold entry title.
   */
  function companyFromExperienceSection() {
    const anchor = document.getElementById('experience');
    if (!anchor) return null;
    const section = anchor.closest('section') ||
      (anchor.nextElementSibling && anchor.nextElementSibling.tagName === 'SECTION'
        ? anchor.nextElementSibling
        : (anchor.parentElement ? anchor.parentElement.closest('section') : null));
    if (!section) return null;
    const firstLi = section.querySelector('ul > li');
    if (!firstLi) return null;
    const grouped = !!firstLi.querySelector('ul');
    for (const span of firstLi.querySelectorAll('span[aria-hidden="true"]')) {
      if (span.closest('.t-black--light')) continue; // dates / locations
      const isBold = !!span.closest('.t-bold');
      if (grouped ? !isBold : isBold) continue;
      const candidate = cleanCompanyName(span.textContent);
      if (!candidate) continue;
      // Skip date ranges and durations.
      if (/\b(yrs?|mos?)\b/i.test(candidate) || /\b\d{4}\b/.test(candidate)) continue;
      return candidate;
    }
    return null;
  }

  /** Strategy 4: JSON-LD structured data (worksFor, incl. array form). */
  function companyFromJsonLd() {
    const fromNode = (node) => {
      if (!node) return null;
      const worksFor = Array.isArray(node.worksFor) ? node.worksFor[0] : node.worksFor;
      if (worksFor && worksFor.name) return cleanCompanyName(worksFor.name);
      return null;
    };
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const data = JSON.parse(script.textContent);
        const graph = Array.isArray(data) ? data : data['@graph'] || [data];
        for (const node of graph) {
          // ProfilePage wraps the Person in mainEntity; check both levels.
          const c = fromNode(node) || fromNode(node && node.mainEntity);
          if (c) return c;
        }
      } catch {
        // ignore malformed JSON-LD
      }
    }
    return null;
  }

  /**
   * Strategy 5: <meta name="description"> — always present in <head>, never
   * lazy. Public profile format: "Title at Company · Experience: Company ·
   * Education: School · Location: City · N connections on LinkedIn. ..."
   */
  function companyFromMetaDescription() {
    for (const sel of ['meta[name="description"]', 'meta[property="og:description"]']) {
      const meta = document.querySelector(sel);
      const content = meta ? (meta.getAttribute('content') || '') : '';
      if (!content) continue;
      const m = content.match(/Experience:\s*([^·]+?)\s*·/) ||
        content.match(/Experience:\s*([^·|]+?)\s*on LinkedIn/i);
      if (m) {
        const c = cleanCompanyName(m[1]);
        if (c) return c;
      }
      const head = content.split('·')[0];
      if (head) {
        const m2 = head.match(/\s+at\s+(.+)$/i);
        if (m2) {
          const c = cleanCompanyName(m2[1]);
          if (c) return c;
        }
      }
    }
    return null;
  }

  /** Strategy 6: inline page data ("companyName" / worksFor in embedded JSON). */
  function companyFromInlineData() {
    const html = document.documentElement.innerHTML || '';
    const m = html.match(/"companyName"\s*:\s*"([^"]+)"/) ||
              html.match(/"worksFor"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
    if (!m) return null;
    try {
      return cleanCompanyName(decodeURIComponent(m[1]));
    } catch {
      return cleanCompanyName(m[1]);
    }
  }

  /**
   * Extract profile info for campaign merge fields:
   * { profileId, fullName, firstName, company }.
   * Reads the profile page's heading, headline, JSON-LD, and inline data.
   */
  function extractProfileInfoFromPage() {
    const info = {
      profileId: extractProfileIdFromPage(),
      fullName: null,
      firstName: null,
      company: null
    };

    // 1. Name from the profile H1.
    const h1 = document.querySelector('h1');
    if (h1 && h1.textContent.trim()) {
      info.fullName = h1.textContent.trim().split('\n')[0].trim();
    }

    // 2. Name from JSON-LD if the H1 missed.
    if (!info.fullName) {
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const data = JSON.parse(script.textContent);
          const graph = Array.isArray(data) ? data : data['@graph'] || [data];
          for (const node of graph) {
            if (!info.fullName && node && node.name) info.fullName = node.name;
          }
        } catch {
          // ignore malformed JSON-LD
        }
      }
    }

    // 3. Name from document title ("Name | LinkedIn") as last resort.
    if (!info.fullName) {
      const title = document.title || '';
      const name = title.split('|')[0].trim();
      if (name && !/linkedin/i.test(name)) info.fullName = name;
    }

    // Company: ordered from most-reliable/always-rendered to least.
    info.company =
      companyFromHeadline() ||
      companyFromTopCard() ||
      companyFromExperienceSection() ||
      companyFromJsonLd() ||
      companyFromMetaDescription() ||
      companyFromInlineData();

    if (info.fullName) {
      info.firstName = info.fullName.split(/\s+/)[0];
    }

    return info;
  }

  // Listen for commands from the popup / background service worker.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'sendLinkedInMessage') {
      console.log('[LDMS] received sendLinkedInMessage on tab', window.location.href);

      // Acknowledge immediately and close the message channel to avoid the
      // "message channel closed before a response was received" error.
      try {
        sendResponse({ received: true });
      } catch {
        // Channel may already be closed.
      }

      // Run the long send operation out-of-band and report completion via
      // a separate chrome.runtime.sendMessage.
      (async () => {
        try {
          await sendLinkedInMessage(request.payload);
          chrome.runtime.sendMessage({
            action: 'sendComplete',
            messageId: request.payload.id,
            success: true
          });
        } catch (err) {
          chrome.runtime.sendMessage({
            action: 'sendComplete',
            messageId: request.payload.id,
            success: false,
            error: String(err && err.message || err)
          });
        }
      })();

      return false;
    }

    if (request.action === 'getConnections') {
      try {
        const names = extractConnections();
        sendResponse({ success: true, connections: names });
      } catch (err) {
        sendResponse({ success: false, error: String(err && err.message || err) });
      }
      return false;
    }

    if (request.action === 'extractProfileId') {
      console.log('[LDMS] extractProfileId on tab', window.location.href);
      try {
        const profileId = extractProfileIdFromPage();
        if (profileId) {
          sendResponse({ success: true, profileId });
        } else {
          sendResponse({ success: false, error: 'Profile ID not found on page' });
        }
      } catch (err) {
        sendResponse({ success: false, error: String(err && err.message || err) });
      }
      return false;
    }

    if (request.action === 'extractProfileInfo') {
      console.log('[LDMS] extractProfileInfo on tab', window.location.href);
      try {
        // Trigger lazy-loading of lower profile sections (experience etc.) so
        // they are in the DOM by the time the background retries extraction.
        try {
          window.scrollTo(0, Math.floor(document.body.scrollHeight / 2));
        } catch { /* ignore */ }
        const info = extractProfileInfoFromPage();
        console.log('[LDMS] extractProfileInfo result:', JSON.stringify(info));
        sendResponse({ success: true, ...info });
      } catch (err) {
        sendResponse({ success: false, error: String(err && err.message || err) });
      }
      return false;
    }
  });
})();
