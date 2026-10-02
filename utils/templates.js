/**
 * Template helpers: placeholder extraction and substitution.
 */

const Templates = (() => {
  const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;

  /**
   * Extracts placeholder names from a template body.
   * @param {string} body
   * @returns {string[]}
   */
  function extractPlaceholders(body = '') {
    const names = new Set();
    let match;
    while ((match = PLACEHOLDER_RE.exec(body)) !== null) {
      names.add(match[1]);
    }
    return Array.from(names);
  }

  /**
   * Replaces placeholders in a template body using the supplied values.
   * @param {string} body
   * @param {Record<string, string>} values
   * @returns {string}
   */
  function applyTemplate(body = '', values = {}) {
    return body.replace(PLACEHOLDER_RE, (match, key) => {
      return values[key] !== undefined ? values[key] : match;
    });
  }

  return {
    extractPlaceholders,
    applyTemplate
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Templates };
}
