/**
 * Popup controller for LinkedIn DM Scheduler.
 */

(function () {
  'use strict';

  const TABS = ['schedule', 'queue', 'templates', 'history', 'settings'];
  let currentSettings = {};
  let allMessages = [];

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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
      renderTemplatesList()
    ]);
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
    $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tab === tabId));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === tabId));

    if (tabId === 'queue') renderQueue();
    if (tabId === 'history') renderHistory();
    if (tabId === 'templates') renderTemplatesList();
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

    $$('.edit-template').forEach((btn) =
      btn.addEventListener('click', async () => {
        const templates = await Storage.getTemplates();
        const t = templates.find((x) => x.id === btn.dataset.id);
        if (!t) return;
        $('#template-edit-id').value = t.id;
        $('#template-name').value = t.name;
        $('#template-body').value = t.body;
        $('#cancel-template-edit').classList.remove('hidden');
        switchTab('templates');
      })
    );

    $$('.delete-template').forEach((btn) =
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this template?')) return;
        await Storage.deleteTemplate(btn.dataset.id);
        await Promise.all([renderTemplatesSelect(), renderTemplatesList()]);
        showToast('Template deleted', 'success');
      })
    );
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  async function onScheduleSubmit(e) {
    e.preventDefault();
    const editId = $('#edit-id').value;
    const recipient = $('#recipient').value.trim();
    const body = $('#message').value.trim();
    const datetime = $('#datetime').value;
    const timezone = $('#timezone').value;
    const recurrence = $('#recurrence').value;

    if (!recipient || !body || !datetime) {
      showToast('Please fill in all required fields', 'error');
      return;
    }

    // Apply placeholder values.
    const placeholderValues = {};
    $$('#placeholder-fields input').forEach((input) => {
      placeholderValues[input.dataset.placeholder] = input.value;
    });
    const finalText = Templates.applyTemplate(body, placeholderValues);

    const scheduledAt = parseDateTimeInTimezone(datetime, timezone);

    if (editId) {
      await Storage.updateMessage(editId, {
        recipient,
        text: finalText,
        timezone,
        recurrence,
        scheduledAt,
        status: 'pending'
      });
      showToast('Message updated', 'success');
    } else {
      await Storage.addMessage({
        recipient,
        text: finalText,
        timezone,
        recurrence,
        scheduledAt,
        status: 'pending'
      });
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

    $$('.edit-message').forEach((btn) =
      btn.addEventListener('click', async () => {
        const m = allMessages.find((x) => x.id === btn.dataset.id);
        if (!m) return;
        loadMessageIntoForm(m);
        switchTab('schedule');
      })
    );

    $$('.delete-message').forEach((btn) =
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this scheduled message?')) return;
        await Storage.deleteMessage(btn.dataset.id);
        await renderQueue();
        showToast('Message deleted', 'success');
      })
    );
  }

  function loadMessageIntoForm(m) {
    $('#edit-id').value = m.id;
    $('#recipient').value = m.recipient;
    $('#message').value = m.text;
    $('#timezone').value = m.timezone || currentSettings.timezone;
    $('#recurrence').value = m.recurrence || 'none';

    const d = new Date(m.scheduledAt);
    // Convert UTC timestamp back to local input value in target timezone is tricky;
    // we display in the browser's local time as a convenience.
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    $('#datetime').value = d.toISOString().slice(0, 16);

    $('#cancel-edit').classList.remove('hidden');
    updatePlaceholderFields();
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
