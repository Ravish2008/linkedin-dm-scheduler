/**
 * Popup controller for LinkedIn DM Scheduler.
 */

(function () {
  'use strict';

  const TABS = ['schedule', 'queue', 'templates', 'campaign', 'history', 'settings'];
  let currentSettings = {};
  let allMessages = [];
  // Campaign builder working state (recipients staged in the UI before save).
  let stagedRecipients = [];
  // Currently selected campaign shown in the dashboard.
  let activeCampaignId = null;
  // Campaign being edited in the builder (null when composing a new campaign).
  let editingCampaignId = null;
  let campaignPollTimer = null;
  // Last active tab (persisted so the popup reopens where the user left off).
  let currentTab = 'schedule';

  // ---------------------------------------------------------------------------
  // Form state persistence
  //
  // Chrome destroys the popup (and all DOM state) whenever it loses focus.
  // To keep user input across reopenings, every field is saved to
  // chrome.storage.local (debounced on input) and restored in init().
  // ---------------------------------------------------------------------------

  const FORM_STATE_KEY = 'popupFormState';
  const FORM_STATE_DEBOUNCE_MS = 250;

  // User-facing fields worth persisting, across all tabs. The file input
  // (#import-data) is excluded: file values cannot be restored.
  const PERSISTED_FIELD_IDS = [
    // Schedule tab
    'edit-id',
    'template-select',
    'recipient',
    'profile-url',
    'message',
    'datetime',
    'timezone',
    'recurrence',
    // Templates tab
    'template-edit-id',
    'template-name',
    'template-body',
    // Campaign tab
    'campaign-name',
    'campaign-recipients-input',
    'campaign-template-select',
    'campaign-message',
    'campaign-daily-cap',
    'campaign-weekly-cap',
    'campaign-min-delay',
    'campaign-min-delay-unit',
    'campaign-max-delay',
    'campaign-max-delay-unit',
    'campaign-active-start',
    'campaign-active-end',
    'campaign-warmup',
    // History / Settings tabs
    'history-filter',
    'default-timezone',
    'enable-notifications',
    'dark-mode'
  ];

  let formStateSaveTimer = null;

  function collectFormState() {
    const fields = {};
    for (const id of PERSISTED_FIELD_IDS) {
      const el = document.getElementById(id);
      if (!el) continue;
      fields[id] = el.type === 'checkbox' ? el.checked : el.value;
    }

    // Dynamic template placeholder inputs (placeholder-{key}) in the
    // Schedule form, keyed by their data-placeholder attribute.
    const placeholders = {};
    document.querySelectorAll('#placeholder-fields input[data-placeholder]').forEach((el) => {
      placeholders[el.dataset.placeholder] = el.value;
    });

    return {
      fields,
      placeholders,
      stagedRecipients,
      activeCampaignId,
      editingCampaignId,
      activeTab: currentTab,
      savedAt: Date.now()
    };
  }

  async function saveFormStateNow() {
    try {
      await chrome.storage.local.set({ [FORM_STATE_KEY]: collectFormState() });
    } catch (err) {
      console.warn('[Popup] Could not save form state:', err.message);
    }
  }

  function scheduleFormStateSave() {
    clearTimeout(formStateSaveTimer);
    formStateSaveTimer = setTimeout(saveFormStateNow, FORM_STATE_DEBOUNCE_MS);
  }

  /**
   * Restore persisted form state into the re-created popup DOM.
   * Must run after init() has populated selects and set defaults.
   */
  async function restoreFormState() {
    let state = null;
    try {
      const data = await chrome.storage.local.get(FORM_STATE_KEY);
      state = data && data[FORM_STATE_KEY];
    } catch (err) {
      console.warn('[Popup] Could not read form state:', err.message);
      return;
    }
    if (!state || !state.fields) return;

    // 1. Static fields.
    for (const id of PERSISTED_FIELD_IDS) {
      if (!(id in state.fields)) continue;
      const el = document.getElementById(id);
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!state.fields[id];
      else el.value = state.fields[id];
    }

    // 2. A stale datetime from a previous session is a scheduling trap —
    //    keep the fresh default if the saved one is already in the past.
    const datetimeEl = $('#datetime');
    if (datetimeEl.value && new Date(datetimeEl.value).getTime() <= Date.now()) {
      setDefaultDatetimeInput();
    }

    // 3. Rebuild dynamic placeholder inputs from the restored message, then
    //    re-apply their saved values.
    updatePlaceholderFields();
    const savedPlaceholders = state.placeholders || {};
    document.querySelectorAll('#placeholder-fields input[data-placeholder]').forEach((el) => {
      if (el.dataset.placeholder in savedPlaceholders) {
        el.value = savedPlaceholders[el.dataset.placeholder];
      }
    });

    // 4. Edit-mode affordances depend on restored hidden edit IDs.
    $('#cancel-edit').classList.toggle('hidden', !$('#edit-id').value);
    $('#cancel-template-edit').classList.toggle('hidden', !$('#template-edit-id').value);

    // 5. Campaign builder staging.
    if (Array.isArray(state.stagedRecipients)) {
      stagedRecipients = state.stagedRecipients.filter((r) => r && r.id && r.slug);
    }
    renderCampaignRecipientPreview();

    // 5b. Campaign edit mode: fields and staged recipients were restored
    // above; re-apply the edit affordances if the campaign is still
    // editable (draft/paused).
    if (state.editingCampaignId) {
      const campaign = await Storage.getCampaign(state.editingCampaignId);
      if (campaign && (campaign.status === 'draft' || campaign.status === 'paused')) {
        editingCampaignId = state.editingCampaignId;
      }
    }
    applyCampaignEditModeUI(!!editingCampaignId);

    // 6. Campaign dashboard selection (only if the campaign still exists).
    if (state.activeCampaignId) {
      const campaign = await Storage.getCampaign(state.activeCampaignId);
      if (campaign) {
        activeCampaignId = state.activeCampaignId;
        renderCampaignDashboard();
      }
    }

    // 7. Views that read field values need a re-render post-restore.
    renderHistory();

    // 8. Return the user to the tab they were on.
    const tab = TABS.includes(state.activeTab) ? state.activeTab : 'schedule';
    switchTab(tab);
  }

  // ---------------------------------------------------------------------------
  // Utility helpers
  // ---------------------------------------------------------------------------

  function $(selector) {
    return document.querySelector(selector);
  }

  function $$(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  function showToast(text, type = 'info') {
    const toast = $('#toast');
    toast.textContent = text;
    toast.className = `toast ${type} show`;
    setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function formatDateTime(timestamp, timezone) {
    if (!timestamp) return '-';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: timezone || currentSettings.timezone,
        timeZoneName: 'short'
      }).format(new Date(timestamp));
    } catch {
      return new Date(timestamp).toLocaleString();
    }
  }

  function getPartsInTimezone(timestamp, timezone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
    });
    const parts = dtf.formatToParts(new Date(timestamp));
    const map = {};
    for (const part of parts) {
      if (part.type !== 'literal') map[part.type] = parseInt(part.value, 10);
    }
    return map;
  }

  function wallTimeAsUtcInTimezone(year, month, day, hour, minute, timezone) {
    const parts = getPartsInTimezone(Date.UTC(year, month - 1, day, hour, minute), timezone);
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  }

  /**
   * Convert a YYYY-MM-DDTHH:mm value interpreted in `timezone` to a UTC timestamp.
   */
  function parseDateTimeInTimezone(inputValue, timezone) {
    const [datePart, timePart] = inputValue.split('T');
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, minute] = timePart.split(':').map(Number);

    let naive = Date.UTC(year, month - 1, day, hour, minute);
    // Iteratively resolve DST and timezone offset.
    for (let i = 0; i < 3; i++) {
      const wallAsUtc = wallTimeAsUtcInTimezone(
        new Date(naive).getUTCFullYear(),
        new Date(naive).getUTCMonth() + 1,
        new Date(naive).getUTCDate(),
        new Date(naive).getUTCHours(),
        new Date(naive).getUTCMinutes(),
        timezone
      );
      const offset = naive - wallAsUtc;
      const next = Date.UTC(year, month - 1, day, hour, minute) + offset;
      if (Math.abs(next - naive) < 1000) break;
      naive = next;
    }
    return naive;
  }

  function formatDateTimeLocalInTimezone(timestamp, timezone) {
    const parts = getPartsInTimezone(timestamp, timezone);
    const pad = (n) => String(n).padStart(2, '0');
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Attribute-safe escaping (escapeHtml does not escape quotes, and the
   * textContent->innerHTML trick leaves " intact).
   */
  function escapeAttr(str) {
    return escapeHtml(str).replace(/"/g, '&quot;');
  }

  /**
   * Extract the LinkedIn profile slug from a profile URL.
   * Accepts urls like https://www.linkedin.com/in/username/ or linkedin.com/in/username.
   */
  function extractProfileSlug(url) {
    if (!url) return null;
    try {
      const trimmed = url.trim();
      const urlObj = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
      const match = urlObj.pathname.match(/\/in\/([^/]+)/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function profileSlugBadge(slug) {
    return slug
      ? `<p class="card-meta" title="linkedin.com/in/${escapeHtml(slug)}">Slug: ${escapeHtml(slug)}</p>`
      : '';
  }

  function getTimezoneList() {
    try {
      if (Intl.supportedValuesOf) {
        return Intl.supportedValuesOf('timeZone');
      }
    } catch {
      // fall through
    }
    return [
      'UTC',
      'America/New_York',
      'America/Chicago',
      'America/Denver',
      'America/Los_Angeles',
      'America/Toronto',
      'America/Sao_Paulo',
      'Europe/London',
      'Europe/Paris',
      'Europe/Berlin',
      'Europe/Moscow',
      'Asia/Dubai',
      'Asia/Kolkata',
      'Asia/Singapore',
      'Asia/Shanghai',
      'Asia/Tokyo',
      'Asia/Seoul',
      'Australia/Sydney',
      'Pacific/Auckland'
    ];
  }

  function populateTimezoneSelect(selectEl, selectedValue) {
    selectEl.innerHTML = '';
    for (const tz of getTimezoneList()) {
      const option = document.createElement('option');
      option.value = tz;
      option.textContent = tz;
      if (tz === selectedValue) option.selected = true;
      selectEl.appendChild(option);
    }
  }

  function setDefaultDatetimeInput() {
    const input = $('#datetime');
    const now = new Date();
    now.setMinutes(now.getMinutes() + 60); // +1 hour from now
    now.setSeconds(0, 0);
    // datetime-local expects local time; toISOString returns UTC, so adjust by offset.
    const localIso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
    input.value = localIso;
  }

  // ---------------------------------------------------------------------------
  // UI initialisation
  // ---------------------------------------------------------------------------

  async function init() {
    currentSettings = await Storage.getSettings();

    // Theme
    document.body.classList.toggle('dark', currentSettings.darkMode);

    // Tabs
    $('.tab-nav').addEventListener('click', onTabClick);

    // Schedule form
    $('#schedule-form').addEventListener('submit', onScheduleSubmit);
    $('#template-select').addEventListener('change', onTemplateSelect);
    $('#message').addEventListener('input', onMessageInput);
    $('#cancel-edit').addEventListener('click', resetScheduleForm);
    $('#refresh-connections').addEventListener('click', refreshConnections);

    // Template form
    $('#template-form').addEventListener('submit', onTemplateSubmit);
    $('#cancel-template-edit').addEventListener('click', resetTemplateForm);

    // History filter
    $('#history-filter').addEventListener('change', renderHistory);

    // Settings form
    $('#settings-form').addEventListener('submit', onSettingsSubmit);
    $('#test-notification').addEventListener('click', testNotification);

    // Import / Export
    $('#export-data').addEventListener('click', exportData);
    $('#import-data').addEventListener('change', importData);

    // Queue list actions (delegated because items are recreated on render)
    initQueueEventDelegation();

    // Template list actions (delegated because items are recreated on render)
    initTemplatesEventDelegation();

    // Campaign builder + dashboard
    $('#campaign-add-recipients').addEventListener('click', onAddCampaignRecipients);
    $('#campaign-create').addEventListener('click', onCreateCampaign);
    $('#campaign-clear').addEventListener('click', clearCampaignBuilder);
    $('#cancel-campaign-edit').addEventListener('click', () => {
      clearCampaignBuilder();
      showToast('Campaign edit cancelled', 'info');
    });
    $('#campaign-template-select').addEventListener('change', onCampaignTemplateSelect);
    $('#campaign-btn-pause').addEventListener('click', () => onCampaignControl('pause'));
    $('#campaign-btn-resume').addEventListener('click', () => onCampaignControl('resume'));
    $('#campaign-btn-cancel').addEventListener('click', () => onCampaignControl('cancel'));
    $('#campaign-btn-delete').addEventListener('click', onDeleteCampaign);
    initCampaignEventDelegation();

    // Keep the campaign dashboard in sync with background progress.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.campaigns && activeCampaignId) {
        renderCampaignDashboard();
        renderCampaignList();
      }
    });

    // Form state persistence: capture every user edit (debounced), including
    // dynamically created fields, via delegated listeners on document.
    document.addEventListener('input', scheduleFormStateSave);
    document.addEventListener('change', scheduleFormStateSave);
    // Best-effort flush when the popup is torn down.
    window.addEventListener('pagehide', saveFormStateNow);

    // Show the browser's local timezone next to the datetime picker.
    $('#datetime-tz-hint').textContent = `Browser timezone: ${currentSettings.timezone}`;
    $('#campaign-tz-hint').textContent =
      `Active hours use the browser's local timezone (${currentSettings.timezone}).`;

    populateTimezoneSelect($('#timezone'), currentSettings.timezone);
    populateTimezoneSelect($('#default-timezone'), currentSettings.timezone);

    $('#enable-notifications').checked = currentSettings.notifications;
    $('#dark-mode').checked = currentSettings.darkMode;

    setDefaultDatetimeInput();

    await refreshConnections(true);
    await Promise.all([
      renderTemplatesSelect(),
      renderQueue(),
      renderHistory(),
      renderTemplatesList(),
      renderCampaignTemplatesSelect(),
      renderCampaignList()
    ]);

    // Restore the user's in-progress form state and last active tab. Must run
    // after selects are populated and defaults are set so restored values win.
    await restoreFormState();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function onTabClick(e) {
    if (!e.target.matches('.tab-btn')) return;
    const tabId = e.target.dataset.tab;
    switchTab(tabId);
  }

  function switchTab(tabId) {
    currentTab = tabId;
    $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));

    if (tabId === 'queue') renderQueue();
    if (tabId === 'history') renderHistory();
    if (tabId === 'templates') renderTemplatesList();
    if (tabId === 'campaign') {
      renderCampaignTemplatesSelect();
      renderCampaignRecipientPreview();
      renderCampaignList();
      renderCampaignDashboard();
    }

    // Persist immediately so the popup reopens on this tab. This also captures
    // programmatic form changes made just before a switchTab (e.g. edit flows).
    saveFormStateNow();
  }

  // ---------------------------------------------------------------------------
  // Contacts / autocomplete
  // ---------------------------------------------------------------------------

  async function refreshConnections(silent = false) {
    const list = $('#recipient-list');
    list.innerHTML = '';

    // Add cached connections first.
    for (const name of currentSettings.cachedConnections || []) {
      const option = document.createElement('option');
      option.value = name;
      list.appendChild(option);
    }

    try {
      const tabs = await chrome.tabs.query({
        url: ['https://www.linkedin.com/messaging/*']
      });
      if (!tabs || tabs.length === 0) {
        if (!silent) showToast('Open LinkedIn messaging to refresh contacts', 'info');
        return;
      }

      const response = await chrome.tabs.sendMessage(tabs[0].id, {
        action: 'getConnections'
      });

      if (response && response.success && Array.isArray(response.connections)) {
        list.innerHTML = '';
        const merged = Array.from(
          new Set([...(currentSettings.cachedConnections || []), ...response.connections])
        );
        currentSettings.cachedConnections = merged;
        await Storage.setSettings(currentSettings);

        for (const name of merged) {
          const option = document.createElement('option');
          option.value = name;
          list.appendChild(option);
        }
        if (!silent) showToast(`Loaded ${response.connections.length} contacts`, 'success');
      }
    } catch (err) {
      if (!silent) showToast('Could not refresh contacts: ' + err.message, 'error');
    }
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  function getSelectedTemplate() {
    return $('#template-select option:checked');
  }

  async function onTemplateSelect() {
    const selected = getSelectedTemplate();
    if (!selected || !selected.value) {
      updatePlaceholderFields();
      return;
    }

    const templates = await Storage.getTemplates();
    const template = templates.find((t) => t.id === selected.value);
    if (!template) return;

    $('#message').value = template.body;
    updatePlaceholderFields();
  }

  function onMessageInput() {
    updatePlaceholderFields();
  }

  function updatePlaceholderFields() {
    const container = $('#placeholder-fields');
    container.innerHTML = '';
    const body = $('#message').value;
    const placeholders = Templates.extractPlaceholders(body);
    if (placeholders.length === 0) return;

    const title = document.createElement('p');
    title.className = 'hint';
    title.textContent = 'Set placeholder values:';
    container.appendChild(title);

    for (const key of placeholders) {
      const wrapper = document.createElement('div');
      wrapper.className = 'field';

      const label = document.createElement('label');
      label.textContent = `{${key}}`;
      label.htmlFor = `placeholder-${key}`;

      const input = document.createElement('input');
      input.type = 'text';
      input.id = `placeholder-${key}`;
      input.dataset.placeholder = key;
      input.placeholder = `Value for ${key}`;

      wrapper.appendChild(label);
      wrapper.appendChild(input);
      container.appendChild(wrapper);
    }
  }

  async function renderTemplatesSelect() {
    const select = $('#template-select');
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- No template --</option>';
    const templates = await Storage.getTemplates();
    for (const t of templates) {
      const option = document.createElement('option');
      option.value = t.id;
      option.textContent = t.name;
      select.appendChild(option);
    }
    select.value = currentValue;
  }

  async function onTemplateSubmit(e) {
    e.preventDefault();
    const id = $('#template-edit-id').value;
    const name = $('#template-name').value.trim();
    const body = $('#template-body').value;

    if (id) {
      await Storage.updateTemplate(id, { name, body });
      showToast('Template updated', 'success');
    } else {
      await Storage.addTemplate({ name, body });
      showToast('Template saved', 'success');
    }

    resetTemplateForm();
    await Promise.all([renderTemplatesSelect(), renderTemplatesList()]);
  }

  function resetTemplateForm() {
    $('#template-form').reset();
    $('#template-edit-id').value = '';
    $('#cancel-template-edit').classList.add('hidden');
    // Programmatic clears don't fire input events; persist explicitly.
    saveFormStateNow();
  }

  async function renderTemplatesList() {
    const list = $('#templates-list');
    const templates = await Storage.getTemplates();
    list.innerHTML = '';

    $('#templates-empty').classList.toggle('hidden', templates.length > 0);

    for (const t of templates) {
      const li = document.createElement('li');
      li.className = 'card';
      li.innerHTML = `
        <div class="card-header">
          <p class="card-title">${escapeHtml(t.name)}</p>
        </div>
        <div class="card-body">${escapeHtml(t.body)}</div>
        <div class="card-actions">
          <button class="btn-secondary edit-template" data-id="${t.id}">Edit</button>
          <button class="btn-secondary delete-template" data-id="${t.id}">Delete</button>
        </div>
      `;
      list.appendChild(li);
    }
  }

  /**
   * Event delegation for template item actions. Buttons are recreated on every
   * renderTemplatesList() call, so a delegated listener avoids stale bindings.
   */
  function initTemplatesEventDelegation() {
    const list = $('#templates-list');

    list.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('.edit-template');
      const deleteBtn = e.target.closest('.delete-template');

      if (editBtn) {
        const id = editBtn.dataset.id;
        const templates = await Storage.getTemplates();
        const t = templates.find((x) => x.id === id);
        if (!t) return;
        $('#template-edit-id').value = t.id;
        $('#template-name').value = t.name;
        $('#template-body').value = t.body;
        $('#cancel-template-edit').classList.remove('hidden');
        switchTab('templates');
        return;
      }

      if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (!confirm('Delete this template?')) return;
        await Storage.deleteTemplate(id);
        await Promise.all([renderTemplatesSelect(), renderTemplatesList()]);
        showToast('Template deleted', 'success');
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  async function onScheduleSubmit(e) {
    e.preventDefault();
    const editId = $('#edit-id').value;
    let recipient = $('#recipient').value.trim();
    const profileUrl = $('#profile-url').value.trim();
    const profileSlug = extractProfileSlug(profileUrl);
    const body = $('#message').value.trim();
    const datetime = $('#datetime').value;
    const timezone = $('#timezone').value;
    const recurrence = $('#recurrence').value;

    if (profileUrl && !profileSlug) {
      showToast('Could not extract a profile slug from the URL. Use linkedin.com/in/username.', 'error');
      return;
    }

    if (!recipient) {
      showToast('Please provide a recipient name. The LinkedIn URL is optional and used only to disambiguate duplicate names.', 'error');
      return;
    }

    if (!body || !datetime) {
      showToast('Please fill in the message and date/time fields.', 'error');
      return;
    }

    // Apply placeholder values.
    const placeholderValues = {};
    $$('#placeholder-fields input').forEach((input) => {
      placeholderValues[input.dataset.placeholder] = input.value;
    });
    const finalText = Templates.applyTemplate(body, placeholderValues);

    const scheduledAt = parseDateTimeInTimezone(datetime, timezone);

    const messagePayload = {
      recipient,
      text: finalText,
      timezone,
      recurrence,
      scheduledAt,
      status: 'pending',
      profileUrl: profileUrl || null,
      profileSlug: profileSlug || null
    };

    if (editId) {
      await Storage.updateMessage(editId, messagePayload);
      showToast('Message updated', 'success');
    } else {
      await Storage.addMessage(messagePayload);
      showToast('Message scheduled', 'success');
    }

    resetScheduleForm();
    switchTab('queue');
    await renderQueue();
  }

  function resetScheduleForm() {
    $('#schedule-form').reset();
    $('#edit-id').value = '';
    $('#cancel-edit').classList.add('hidden');
    $('#template-select').value = '';
    $('#placeholder-fields').innerHTML = '';
    populateTimezoneSelect($('#timezone'), currentSettings.timezone);
    setDefaultDatetimeInput();
    // Programmatic clears don't fire input events; persist explicitly.
    saveFormStateNow();
  }

  async function renderQueue() {
    const list = $('#queue-list');
    allMessages = await Storage.getMessages();
    const pending = allMessages
      .filter((m) => m.status === 'pending')
      .sort((a, b) => a.scheduledAt - b.scheduledAt);

    $('#queue-count').textContent = pending.length;
    list.innerHTML = '';
    $('#queue-empty').classList.toggle('hidden', pending.length > 0);

    for (const m of pending) {
      const li = document.createElement('li');
      li.className = 'card';
      li.innerHTML = `
        <div class="card-header">
          <p class="card-title">${escapeHtml(m.recipient)}</p>
          <span class="status pending">Pending</span>
        </div>
        ${profileSlugBadge(m.profileSlug)}
        <p class="card-meta">${formatDateTime(m.scheduledAt, m.timezone)}</p>
        ${m.recurrence !== 'none' ? `<p class="card-meta">Recurs: ${m.recurrence}</p>` : ''}
        <div class="card-body">${escapeHtml(m.text)}</div>
        <div class="card-actions">
          <button class="btn-secondary edit-message" data-id="${m.id}">Edit</button>
          <button class="btn-secondary delete-message" data-id="${m.id}">Delete</button>
        </div>
      `;
      list.appendChild(li);
    }

    // Buttons are rendered dynamically; event delegation is registered once in initQueueEventDelegation().
  }

  /**
   * Event delegation for queue item actions. Buttons are recreated on every
   * renderQueue() call, so delegated listeners avoid stale bindings.
   */
  function initQueueEventDelegation() {
    const list = $('#queue-list');

    list.addEventListener('click', async (e) => {
      const editBtn = e.target.closest('.edit-message');
      const deleteBtn = e.target.closest('.delete-message');

      if (editBtn) {
        const id = editBtn.dataset.id;
        const m = allMessages.find((x) => x.id === id);
        if (!m) return;
        loadMessageIntoForm(m);
        switchTab('schedule');
        return;
      }

      if (deleteBtn) {
        const id = deleteBtn.dataset.id;
        if (!confirm('Delete this scheduled message?')) return;
        await Storage.deleteMessage(id);
        await renderQueue();
        showToast('Message deleted', 'success');
      }
    });
  }

  function loadMessageIntoForm(m) {
    $('#edit-id').value = m.id;
    $('#recipient').value = m.recipient;
    $('#profile-url').value = m.profileUrl || '';
    $('#message').value = m.text;
    $('#timezone').value = m.timezone || currentSettings.timezone;
    $('#recurrence').value = m.recurrence || 'none';

    // datetime-local uses a wall-clock value with no timezone suffix, so show the
    // stored time in the message's target timezone.
    $('#datetime').value = formatDateTimeLocalInTimezone(
      m.scheduledAt,
      m.timezone || currentSettings.timezone
    );

    $('#cancel-edit').classList.remove('hidden');
    updatePlaceholderFields();
  }

  // ---------------------------------------------------------------------------
  // Campaign
  // ---------------------------------------------------------------------------

  async function renderCampaignTemplatesSelect() {
    const select = $('#campaign-template-select');
    const currentValue = select.value;
    select.innerHTML = '<option value="">-- No template --</option>';
    const templates = await Storage.getTemplates();
    for (const t of templates) {
      const option = document.createElement('option');
      option.value = t.id;
      option.textContent = t.name;
      select.appendChild(option);
    }
    select.value = currentValue;
  }

  async function onCampaignTemplateSelect() {
    const selected = $('#campaign-template-select option:checked');
    if (!selected || !selected.value) return;
    const templates = await Storage.getTemplates();
    const template = templates.find((t) => t.id === selected.value);
    if (template) {
      $('#campaign-message').value = template.body;
      // The new message may introduce custom {{placeholders}} — re-render
      // the per-recipient input fields.
      renderCampaignRecipientPreview();
    }
  }

  function onAddCampaignRecipients() {
    const input = $('#campaign-recipients-input');
    const parsed = Campaign.parseRecipientUrls(input.value);
    if (parsed.length === 0) {
      showToast('No valid LinkedIn profile URLs found. Use linkedin.com/in/username per line.', 'error');
      return;
    }
    const existing = new Set(stagedRecipients.map((r) => r.slug));
    let added = 0;
    for (const r of parsed) {
      if (existing.has(r.slug)) continue;
      existing.add(r.slug);
      stagedRecipients.push({ ...r, id: Storage.generateId(), placeholders: {} });
      added++;
    }
    input.value = '';
    renderCampaignRecipientPreview();
    // stagedRecipients changed programmatically; persist explicitly.
    saveFormStateNow();
    showToast(`Added ${added} recipient${added === 1 ? '' : 's'}`, added ? 'success' : 'info');
  }

  function renderCampaignRecipientPreview() {
    const list = $('#campaign-recipient-preview');
    list.innerHTML = '';
    $('#campaign-recipient-count').textContent = stagedRecipients.length;
    $('#campaign-recipient-empty').classList.toggle('hidden', stagedRecipients.length > 0);

    // Custom {{placeholders}} in the message get per-recipient input fields.
    const customKeys = Campaign.extractCustomPlaceholders($('#campaign-message').value);

    for (const r of stagedRecipients) {
      const li = document.createElement('li');

      if (customKeys.length === 0) {
        // Compact chip layout when there are no per-recipient fields.
        li.className = 'recipient-chip';
        li.innerHTML = `
          <span class="recipient-chip-slug" title="${escapeAttr(r.profileUrl)}">${escapeHtml(r.slug)}</span>
          <button type="button" class="recipient-remove" data-id="${r.id}" aria-label="Remove">×</button>
        `;
      } else {
        // Chip + per-recipient custom placeholder inputs.
        li.className = 'recipient-item';
        const fields = customKeys.map((key) => `
          <label class="recipient-placeholder-field">
            <span>${escapeHtml(key)}</span>
            <input type="text" class="recipient-placeholder-input"
                   data-recipient-id="${r.id}"
                   data-placeholder-key="${escapeAttr(key)}"
                   value="${escapeAttr((r.placeholders && r.placeholders[key]) || '')}"
                   placeholder="${escapeAttr(key)}" />
          </label>`).join('');
        li.innerHTML = `
          <div class="recipient-chip">
            <span class="recipient-chip-slug" title="${escapeAttr(r.profileUrl)}">${escapeHtml(r.slug)}</span>
            <button type="button" class="recipient-remove" data-id="${r.id}" aria-label="Remove">×</button>
          </div>
          <div class="recipient-placeholders">${fields}</div>
        `;
      }
      list.appendChild(li);
    }
  }

  /**
   * Write a total-seconds delay into a number + unit input pair, choosing
   * the unit that displays most cleanly.
   */
  function setDelayInputs(valueId, unitId, totalSec) {
    const input = $('#' + valueId);
    const unit = $('#' + unitId);
    if (totalSec == null || isNaN(totalSec)) {
      input.value = '';
      unit.value = 'min';
      return;
    }
    if (totalSec % 60 === 0) {
      input.value = totalSec / 60;
      unit.value = 'min';
    } else {
      input.value = totalSec;
      unit.value = 'sec';
    }
  }

  function readCampaignSettingsFromForm() {
    // Delay inputs are a number + unit (seconds or minutes); store seconds.
    // Allowed: min delay 10 s – 30 min, max delay 30 s – 60 min.
    const toSeconds = (valueId, unitId, fallbackSec) => {
      let n = parseFloat($('#' + valueId).value);
      if (isNaN(n)) return fallbackSec;
      const unitSec = $('#' + unitId).value === 'min' ? 60 : 1;
      return Math.round(n * unitSec);
    };
    // Caps are optional: empty or <= 0 means unlimited (stored as null).
    const optionalCap = (el, min, max) => {
      const raw = String(el.value).trim();
      if (!raw) return null;
      let v = parseInt(raw, 10);
      if (isNaN(v) || v <= 0) return null;
      return Math.max(min, Math.min(max, v));
    };
    return {
      dailyCap: optionalCap($('#campaign-daily-cap'), 10, 100),
      weeklyCap: optionalCap($('#campaign-weekly-cap'), 50, 200),
      minDelaySec: Math.max(10, Math.min(1800, toSeconds('campaign-min-delay', 'campaign-min-delay-unit', 180))),
      maxDelaySec: Math.max(30, Math.min(3600, toSeconds('campaign-max-delay', 'campaign-max-delay-unit', 480))),
      activeStart: $('#campaign-active-start').value || '09:00',
      activeEnd: $('#campaign-active-end').value || '18:00',
      warmup: $('#campaign-warmup').checked
    };
  }

  /**
   * Toggle builder affordances between create and edit mode.
   */
  function applyCampaignEditModeUI(isEditing) {
    $('#campaign-create').textContent = isEditing ? 'Save changes' : 'Create campaign';
    $('#cancel-campaign-edit').classList.toggle('hidden', !isEditing);
  }

  /**
   * Read + validate the campaign builder form. Returns { name, message,
   * settings } or null (with a toast) when invalid. Shared by create and
   * edit-save flows.
   */
  function validateCampaignForm() {
    const name = $('#campaign-name').value.trim() || `Campaign ${new Date().toLocaleDateString()}`;
    const message = $('#campaign-message').value.trim();

    if (stagedRecipients.length === 0) {
      showToast('Add at least one recipient profile URL.', 'error');
      return null;
    }
    if (!message) {
      showToast('Write a message or pick a template.', 'error');
      return null;
    }

    // Custom {{placeholders}} need a value for every staged recipient — a
    // blank would silently strip them from the sent message.
    const customKeys = Campaign.extractCustomPlaceholders(message);
    if (customKeys.length) {
      const missing = stagedRecipients.filter((r) =>
        customKeys.some((k) => !String((r.placeholders && r.placeholders[k]) || '').trim())
      );
      if (missing.length) {
        const missingKey = customKeys.find((k) =>
          !String((missing[0].placeholders && missing[0].placeholders[k]) || '').trim()
        );
        showToast(
          `Fill in "{{${missingKey}}}" for ${missing.length} recipient${missing.length === 1 ? '' : 's'} (e.g. ${missing[0].slug}).`,
          'error'
        );
        return null;
      }
    }

    const settings = readCampaignSettingsFromForm();
    if (settings.minDelaySec >= settings.maxDelaySec) {
      showToast('Min delay must be less than max delay.', 'error');
      return null;
    }
    return { name, message, settings };
  }

  /**
   * Load a draft/paused campaign back into the builder for editing.
   * Sent/skipped recipients are not re-staged (they are preserved on save).
   */
  async function startEditCampaign(campaignId) {
    const campaign = await Storage.getCampaign(campaignId);
    if (!campaign) return;
    if (campaign.status !== 'draft' && campaign.status !== 'paused') {
      showToast('Only draft or paused campaigns can be edited.', 'error');
      return;
    }

    editingCampaignId = campaign.id;

    // Name, message and all settings.
    $('#campaign-name').value = campaign.name || '';
    $('#campaign-message').value = campaign.message || '';
    $('#campaign-recipients-input').value = '';
    const s = campaign.settings || {};
    $('#campaign-daily-cap').value = s.dailyCap != null ? s.dailyCap : '';
    $('#campaign-weekly-cap').value = s.weeklyCap != null ? s.weeklyCap : '';
    const delays = Campaign.delaySettings(s);
    setDelayInputs('campaign-min-delay', 'campaign-min-delay-unit', delays.minDelaySec);
    setDelayInputs('campaign-max-delay', 'campaign-max-delay-unit', delays.maxDelaySec);
    $('#campaign-active-start').value = s.activeStart || '09:00';
    $('#campaign-active-end').value = s.activeEnd || '18:00';
    $('#campaign-warmup').checked = !!s.warmup;

    // Preselect the template if the campaign message matches one exactly.
    await renderCampaignTemplatesSelect();
    const templates = await Storage.getTemplates();
    const match = templates.find((t) => t.body === campaign.message);
    $('#campaign-template-select').value = match ? match.id : '';

    // Re-stage unfinished recipients; keep resolved profile IDs and
    // per-recipient custom placeholder values for reuse.
    stagedRecipients = (campaign.recipients || [])
      .filter((r) => r.status === 'pending' || r.status === 'failed' || r.status === 'sending')
      .map((r) => ({
        id: r.id,
        profileUrl: r.profileUrl,
        slug: r.slug,
        name: r.slug,
        profileId: r.profileId || null,
        placeholders: { ...(r.placeholders || {}) }
      }));
    renderCampaignRecipientPreview();

    applyCampaignEditModeUI(true);
    $('#campaign-builder').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Builder was populated programmatically; persist explicitly.
    saveFormStateNow();
    showToast(`Editing "${campaign.name}" — already-sent recipients are kept.`, 'info');
  }

  /**
   * Save builder changes back into the campaign being edited. Completed
   * (sent/skipped) recipients and all engine counters are preserved.
   */
  async function saveCampaignEdit() {
    const existing = await Storage.getCampaign(editingCampaignId);
    if (!existing) {
      showToast('This campaign no longer exists.', 'error');
      clearCampaignBuilder();
      return;
    }
    if (existing.status !== 'draft' && existing.status !== 'paused') {
      showToast('Campaign is running — pause it before saving edits.', 'error');
      return;
    }

    const input = validateCampaignForm();
    if (!input) return;

    // Completed recipients stay untouched; staged ones are re-added as pending.
    const completed = (existing.recipients || []).filter(
      (r) => r.status === 'sent' || r.status === 'skipped'
    );
    const bySlug = new Map((existing.recipients || []).map((r) => [r.slug, r]));
    const recipients = completed.concat(
      stagedRecipients.map((r) => {
        const prev = bySlug.get(r.slug);
        return {
          id: r.id,
          profileUrl: r.profileUrl,
          slug: r.slug,
          name: r.slug,
          status: 'pending',
          profileId: r.profileId || (prev && prev.profileId) || null,
          placeholders: { ...(r.placeholders || {}) },
          error: null,
          sentAt: null
        };
      })
    );

    await Storage.updateCampaign(existing.id, {
      name: input.name,
      message: input.message,
      recipients,
      settings: input.settings
    });

    activeCampaignId = existing.id;
    clearCampaignBuilder();
    await Promise.all([renderCampaignList(), renderCampaignDashboard()]);
    // Selection + edit state changed after the builder was cleared; persist.
    saveFormStateNow();
    showToast('Campaign updated', 'success');
  }

  async function onCreateCampaign() {
    // Edit mode: save changes into the existing campaign instead of
    // creating a new one (no auto-start; status stays draft/paused).
    if (editingCampaignId) {
      await saveCampaignEdit();
      return;
    }

    const input = validateCampaignForm();
    if (!input) return;

    const recipients = stagedRecipients.map((r) => ({
      id: r.id,
      profileUrl: r.profileUrl,
      slug: r.slug,
      name: r.slug,
      status: 'pending',
      profileId: null,
      placeholders: { ...(r.placeholders || {}) },
      error: null,
      sentAt: null
    }));

    const campaign = await Storage.addCampaign({
      name: input.name,
      message: input.message,
      recipients,
      settings: input.settings,
      status: 'draft',
      sentToday: 0,
      sentThisWeek: 0,
      dayKey: null,
      weekKey: null,
      nextSendAt: null,
      warmupStartAt: null,
      lastError: null
    });

    clearCampaignBuilder();
    activeCampaignId = campaign.id;
    await Promise.all([renderCampaignList(), renderCampaignDashboard()]);

    // Auto-start the campaign immediately.
    const result = await chrome.runtime.sendMessage({
      action: 'campaignControl',
      command: 'start',
      campaignId: campaign.id
    });
    if (result && result.success) {
      showToast(`Campaign started with ${recipients.length} recipients`, 'success');
    } else {
      showToast('Campaign created but failed to start: ' + (result && result.error), 'error');
    }
    await renderCampaignDashboard();
    // The dashboard selection changed after the builder was cleared; persist.
    saveFormStateNow();
  }

  function clearCampaignBuilder() {
    stagedRecipients = [];
    editingCampaignId = null;
    $('#campaign-name').value = '';
    $('#campaign-recipients-input').value = '';
    $('#campaign-message').value = '';
    $('#campaign-template-select').value = '';
    $('#campaign-warmup').checked = false;
    $('#campaign-daily-cap').value = '';
    $('#campaign-weekly-cap').value = '';
    $('#campaign-min-delay').value = 3;
    $('#campaign-min-delay-unit').value = 'min';
    $('#campaign-max-delay').value = 8;
    $('#campaign-max-delay-unit').value = 'min';
    $('#campaign-active-start').value = '09:00';
    $('#campaign-active-end').value = '18:00';
    applyCampaignEditModeUI(false);
    renderCampaignRecipientPreview();
    // Programmatic clears don't fire input events; persist explicitly.
    saveFormStateNow();
  }

  async function renderCampaignList() {
    const campaigns = await Storage.getCampaigns();
    const list = $('#campaign-list');
    list.innerHTML = '';
    $('#campaign-list-empty').classList.toggle('hidden', campaigns.length > 0);

    const sorted = campaigns.slice().sort((a, b) => b.createdAt - a.createdAt);
    for (const c of sorted) {
      const total = (c.recipients || []).length;
      const sent = (c.recipients || []).filter((r) => r.status === 'sent').length;
      const editable = c.status === 'draft' || c.status === 'paused';
      const li = document.createElement('li');
      li.className = 'card campaign-card' + (c.id === activeCampaignId ? ' selected' : '');
      li.dataset.id = c.id;
      li.innerHTML = `
        <div class="card-header">
          <p class="card-title">${escapeHtml(c.name)}</p>
          <span class="status ${c.status}">${c.status}</span>
        </div>
        <p class="card-meta">${sent} / ${total} sent · ${formatDateTime(c.createdAt, currentSettings.timezone)}</p>
        ${editable ? `
        <div class="card-actions">
          <button type="button" class="btn-secondary edit-campaign" data-id="${c.id}">Edit</button>
        </div>` : ''}
      `;
      list.appendChild(li);
    }
  }

  async function renderCampaignDashboard() {
    const dashboard = $('#campaign-dashboard');
    if (!activeCampaignId) {
      dashboard.classList.add('hidden');
      return;
    }
    const campaign = await Storage.getCampaign(activeCampaignId);
    if (!campaign) {
      activeCampaignId = null;
      dashboard.classList.add('hidden');
      return;
    }

    dashboard.classList.remove('hidden');
    $('#campaign-dashboard-name').textContent = campaign.name;
    const statusEl = $('#campaign-dashboard-status');
    statusEl.textContent = campaign.status;
    statusEl.className = `status ${campaign.status}`;

    const recipients = campaign.recipients || [];
    const total = recipients.length;
    const sent = recipients.filter((r) => r.status === 'sent').length;
    const pending = recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length;
    const failed = recipients.filter((r) => r.status === 'failed').length;
    const skipped = recipients.filter((r) => r.status === 'skipped').length;

    const pct = total ? Math.round(((sent + failed + skipped) / total) * 100) : 0;
    $('#campaign-progress-fill').style.width = pct + '%';
    $('#campaign-progress-text').textContent = `${sent} / ${total} sent (${pct}% done)`;
    $('#campaign-stat-sent').textContent = sent;
    $('#campaign-stat-pending').textContent = pending;
    $('#campaign-stat-failed').textContent = failed;
    $('#campaign-stat-skipped').textContent = skipped;

    // Engine status note.
    const noteEl = $('#campaign-engine-note');
    if (campaign.status === 'running') {
      const gate = Campaign.canSendNow(campaign, Date.now());
      noteEl.textContent = gate.ok
        ? 'Engine active — sending next recipient shortly.'
        : `Engine waiting: ${gate.reason.replace(/-/g, ' ')}.`;
    } else {
      noteEl.textContent = '';
    }

    // Controls visibility.
    const isRunning = campaign.status === 'running';
    const isPaused = campaign.status === 'paused';
    const isDraft = campaign.status === 'draft';
    $('#campaign-btn-pause').classList.toggle('hidden', !isRunning);
    $('#campaign-btn-resume').classList.toggle('hidden', !(isPaused || isDraft));
    $('#campaign-btn-resume').textContent = isDraft ? 'Start' : 'Resume';
    $('#campaign-btn-cancel').classList.toggle('hidden',
      !(isRunning || isPaused || isDraft));
    $('#campaign-btn-delete').classList.toggle('hidden',
      isRunning);

    // Per-recipient status list.
    const statusList = $('#campaign-recipient-status-list');
    statusList.innerHTML = '';
    for (const r of recipients) {
      const li = document.createElement('li');
      li.className = 'card recipient-status-card';
      li.innerHTML = `
        <div class="card-header">
          <p class="card-title">${escapeHtml(r.name || r.slug)}</p>
          <span class="status ${r.status}">${r.status}</span>
        </div>
        <p class="card-meta">${escapeHtml(r.slug)}${r.company ? ' · ' + escapeHtml(r.company) : ''}</p>
        ${r.error ? `<p class="card-meta" style="color:var(--danger)">${escapeHtml(r.error)}</p>` : ''}
        ${r.sentAt ? `<p class="card-meta">Sent ${formatDateTime(r.sentAt, currentSettings.timezone)}</p>` : ''}
      `;
      statusList.appendChild(li);
    }
  }

  async function onCampaignControl(command) {
    if (!activeCampaignId) return;
    if (command === 'cancel' && !confirm('Cancel this campaign? Pending recipients will be skipped.')) return;
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'campaignControl',
        command,
        campaignId: activeCampaignId
      });
      if (result && result.success) {
        showToast(`Campaign ${command}${command === 'pause' ? 'd' : command === 'cancel' ? 'led' : 'ed'}`, 'success');
      } else {
        showToast(`Failed to ${command}: ` + (result && result.error), 'error');
      }
    } catch (err) {
      showToast(`Failed to ${command}: ` + err.message, 'error');
    }
    await Promise.all([renderCampaignDashboard(), renderCampaignList()]);
  }

  async function onDeleteCampaign() {
    if (!activeCampaignId) return;
    if (!confirm('Delete this campaign? This cannot be undone.')) return;
    await Storage.deleteCampaign(activeCampaignId);
    activeCampaignId = null;
    $('#campaign-dashboard').classList.add('hidden');
    await renderCampaignList();
    // Selection cleared; persist so the popup doesn't restore a deleted campaign.
    saveFormStateNow();
    showToast('Campaign deleted', 'success');
  }

  /**
   * Event delegation for campaign UI: recipient chips, campaign list selection.
   */
  function initCampaignEventDelegation() {
    // Remove staged recipients from the builder preview.
    $('#campaign-recipient-preview').addEventListener('click', (e) => {
      const removeBtn = e.target.closest('.recipient-remove');
      if (!removeBtn) return;
      stagedRecipients = stagedRecipients.filter((r) => r.id !== removeBtn.dataset.id);
      renderCampaignRecipientPreview();
      // stagedRecipients changed programmatically; persist.
      saveFormStateNow();
    });

    // Write per-recipient custom {{placeholder}} edits back into the staged
    // recipient objects. This listener sits on the preview container (an
    // ancestor of the inputs), so it runs BEFORE the document-level
    // form-state save listener during bubbling — values are written back
    // before the state is collected.
    $('#campaign-recipient-preview').addEventListener('input', (e) => {
      const input = e.target.closest('.recipient-placeholder-input');
      if (!input) return;
      const recipient = stagedRecipients.find((r) => r.id === input.dataset.recipientId);
      if (!recipient) return;
      recipient.placeholders = recipient.placeholders || {};
      recipient.placeholders[input.dataset.placeholderKey] = input.value;
    });

    // Editing the message may add/remove custom {{placeholders}} — refresh
    // the per-recipient input fields. (Values live on the staged recipient
    // objects, so re-rendering never loses them.)
    $('#campaign-message').addEventListener('input', () => {
      renderCampaignRecipientPreview();
    });

    // Select a saved campaign to view its dashboard, or load one into the
    // builder for editing (draft/paused only).
    $('#campaign-list').addEventListener('click', async (e) => {
      const editBtn = e.target.closest('.edit-campaign');
      if (editBtn) {
        await startEditCampaign(editBtn.dataset.id);
        return;
      }
      const card = e.target.closest('.campaign-card');
      if (!card) return;
      activeCampaignId = card.dataset.id;
      renderCampaignDashboard();
      renderCampaignList();
      // Selection changed programmatically; persist.
      saveFormStateNow();
    });
  }

  // ---------------------------------------------------------------------------
  // History / Dashboard
  // ---------------------------------------------------------------------------

  async function renderHistory() {
    allMessages = await Storage.getMessages();
    const filter = $('#history-filter').value;
    const history = allMessages.filter((m) => {
      if (m.status === 'pending' || m.status === 'sending') return false;
      if (filter === 'all') return true;
      return m.status === filter;
    }).sort((a, b) => (b.sentAt || b.scheduledAt) - (a.sentAt || a.scheduledAt));

    const total = allMessages.filter((m) => m.status === 'sent' || m.status === 'failed').length;
    const sent = allMessages.filter((m) => m.status === 'sent').length;
    const failed = allMessages.filter((m) => m.status === 'failed').length;
    const rate = total ? Math.round((sent / total) * 100) : 0;

    $('#stat-total').textContent = total;
    $('#stat-sent').textContent = sent;
    $('#stat-failed').textContent = failed;
    $('#stat-rate').textContent = rate + '%';

    const list = $('#history-list');
    list.innerHTML = '';
    $('#history-empty').classList.toggle('hidden', history.length > 0);

    for (const m of history) {
      const li = document.createElement('li');
      li.className = 'card';
      li.innerHTML = `
        <div class="card-header">
          <p class="card-title">${escapeHtml(m.recipient)}</p>
          <span class="status ${m.status}">${m.status}</span>
        </div>
        ${profileSlugBadge(m.profileSlug)}
        <p class="card-meta">${m.sentAt ? formatDateTime(m.sentAt, m.timezone) : formatDateTime(m.scheduledAt, m.timezone)}</p>
        ${m.error ? `<p class="card-meta" style="color:var(--danger)">Error: ${escapeHtml(m.error)}</p>` : ''}
        <div class="card-body">${escapeHtml(m.text)}</div>
      `;
      list.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  async function onSettingsSubmit(e) {
    e.preventDefault();
    currentSettings.timezone = $('#default-timezone').value;
    currentSettings.notifications = $('#enable-notifications').checked;
    currentSettings.darkMode = $('#dark-mode').checked;
    await Storage.setSettings(currentSettings);

    document.body.classList.toggle('dark', currentSettings.darkMode);
    populateTimezoneSelect($('#timezone'), currentSettings.timezone);
    showToast('Settings saved', 'success');
  }

  async function testNotification() {
    try {
      await chrome.runtime.sendMessage({ action: 'testNotification' });
    } catch (err) {
      showToast('Notification test failed: ' + err.message, 'error');
    }
  }

  async function exportData() {
    const data = await Storage.exportData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `linkedin-dm-scheduler-backup-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup exported', 'success');
  }

  async function importData(e) {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.messages && !data.templates && !data.settings) {
        throw new Error('Invalid backup file');
      }
      await Storage.importData(data);
      currentSettings = await Storage.getSettings();
      document.body.classList.toggle('dark', currentSettings.darkMode);
      populateTimezoneSelect($('#timezone'), currentSettings.timezone);
      populateTimezoneSelect($('#default-timezone'), currentSettings.timezone);
      $('#enable-notifications').checked = currentSettings.notifications;
      $('#dark-mode').checked = currentSettings.darkMode;

      await Promise.all([
        renderTemplatesSelect(),
        renderQueue(),
        renderHistory(),
        renderTemplatesList()
      ]);
      showToast('Backup restored', 'success');
    } catch (err) {
      showToast('Import failed: ' + err.message, 'error');
    }
    e.target.value = '';
  }

  document.addEventListener('DOMContentLoaded', init);
})();
