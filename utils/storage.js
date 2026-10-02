/**
 * Shared storage helpers for LinkedIn DM Scheduler.
 * Uses chrome.storage.local for persistence.
 */

const Storage = (() => {
  const DEFAULT_SETTINGS = {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    notifications: true,
    darkMode: false,
    // Cached list of connection names discovered from LinkedIn.
    cachedConnections: []
  };

  const read = async (key, fallback = undefined) => {
    const result = await chrome.storage.local.get(key);
    return result[key] !== undefined ? result[key] : fallback;
  };

  const write = async (key, value) => {
    await chrome.storage.local.set({ [key]: value });
  };

  const generateId = () => {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  };

  return {
    generateId,

    async getMessages() {
      return (await read('messages')) || [];
    },

    async setMessages(messages) {
      await write('messages', messages);
    },

    async addMessage(message) {
      const messages = await this.getMessages();
      messages.push({
        id: generateId(),
        createdAt: Date.now(),
        status: 'pending',
        ...message
      });
      await this.setMessages(messages);
      return messages[messages.length - 1];
    },

    async updateMessage(id, updates) {
      const messages = await this.getMessages();
      const index = messages.findIndex((m) => m.id === id);
      if (index === -1) return null;
      messages[index] = { ...messages[index], ...updates };
      await this.setMessages(messages);
      return messages[index];
    },

    async deleteMessage(id) {
      const messages = await this.getMessages();
      const filtered = messages.filter((m) => m.id !== id);
      await this.setMessages(filtered);
      return filtered.length !== messages.length;
    },

    async getTemplates() {
      return (await read('templates')) || [];
    },

    async setTemplates(templates) {
      await write('templates', templates);
    },

    async addTemplate(template) {
      const templates = await this.getTemplates();
      templates.push({
        id: generateId(),
        createdAt: Date.now(),
        ...template
      });
      await this.setTemplates(templates);
      return templates[templates.length - 1];
    },

    async updateTemplate(id, updates) {
      const templates = await this.getTemplates();
      const index = templates.findIndex((t) => t.id === id);
      if (index === -1) return null;
      templates[index] = { ...templates[index], ...updates };
      await this.setTemplates(templates);
      return templates[index];
    },

    async deleteTemplate(id) {
      const templates = await this.getTemplates();
      const filtered = templates.filter((t) => t.id !== id);
      await this.setTemplates(filtered);
      return filtered.length !== templates.length;
    },

    async getSettings() {
      return { ...DEFAULT_SETTINGS, ...(await read('settings') || {}) };
    },

    async setSettings(settings) {
      await write('settings', settings);
    },

    async exportData() {
      return {
        messages: await this.getMessages(),
        templates: await this.getTemplates(),
        settings: await this.getSettings(),
        exportedAt: new Date().toISOString()
      };
    },

    async importData(data) {
      if (data.messages) await this.setMessages(data.messages);
      if (data.templates) await this.setTemplates(data.templates);
      if (data.settings) await this.setSettings(data.settings);
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Storage };
}
