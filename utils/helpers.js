/**
 * General Helper Utilities
 * 
 * Shared utility functions used across platforms
 */

/**
 * Safely get nested property from object
 * @param {Object} obj - The object to traverse
 * @param {string} path - Dot-separated path (e.g., 'a.b.c')
 * @param {*} defaultValue - Default value if path not found
 * @returns {*} The value at path or defaultValue
 */
function safeGet(obj, path, defaultValue = '') {
  try {
    return path.split('.').reduce((acc, part) => acc?.[part], obj) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

/**
 * Extract text content from HTML element
 * Uses TreeWalker for better performance on large content
 * @param {Element} element - The DOM element
 * @returns {string} Extracted text content
 */
function extractTextContent(element) {
  if (!element) return '';

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: function(node) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const tagName = node.tagName.toLowerCase();
          if (tagName === 'script' || tagName === 'style') {
            return NodeFilter.FILTER_REJECT;
          }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const textParts = [];
  let currentNode;
  let lastWasBlock = false;

  while (currentNode = walker.nextNode()) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      const text = currentNode.textContent;
      if (text.trim()) {
        textParts.push(text);
        lastWasBlock = false;
      }
    } else if (currentNode.nodeType === Node.ELEMENT_NODE) {
      const tagName = currentNode.tagName.toLowerCase();
      if (['div', 'p', 'br', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
        if (!lastWasBlock && textParts.length > 0) {
          textParts.push('\n');
          lastWasBlock = true;
        }
      }
    }
  }

  return textParts.join('').trim();
}

/**
 * Sanitize timestamp string
 * @param {string} rawTimestamp - Raw timestamp string
 * @returns {string} ISO 8601 timestamp or current time
 */
function sanitizeTimestamp(rawTimestamp) {
  if (!rawTimestamp) return new Date().toISOString();
  
  try {
    const date = new Date(rawTimestamp);
    return isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
  } catch (error) {
    return new Date().toISOString();
  }
}

/**
 * Generate filename with timestamp
 * @param {string} prefix - Filename prefix
 * @param {string} extension - File extension (default: 'csv')
 * @param {string} conversationId - Optional conversation ID to include
 * @returns {string} Generated filename
 */
function generateFilename(prefix = 'export', extension = 'csv', conversationId = null) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  
  const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
  const idPart = conversationId ? `_${conversationId.substring(0, 8)}` : '';
  
  return `${prefix}${idPart}_${timestamp}.${extension}`;
}

/**
 * Deep search for object with specific property
 * @param {Object} obj - Object to search
 * @param {string} property - Property name to find
 * @param {number} maxDepth - Maximum depth to search
 * @param {number} currentDepth - Current depth (internal)
 * @param {WeakSet} visited - Visited objects (internal)
 * @returns {Object|null} Found object or null
 */
function deepSearchForProperty(obj, property, maxDepth = 5, currentDepth = 0, visited = new WeakSet()) {
  if (currentDepth > maxDepth || !obj || typeof obj !== 'object') {
    return null;
  }
  
  if (visited.has(obj)) {
    return null;
  }
  visited.add(obj);
  
  if (obj[property] !== undefined) {
    return obj;
  }
  
  for (const key in obj) {
    try {
      const value = obj[key];
      if (value && typeof value === 'object') {
        const result = deepSearchForProperty(value, property, maxDepth, currentDepth + 1, visited);
        if (result) {
          return result;
        }
      }
    } catch (e) {
      // Skip inaccessible properties
    }
  }
  
  return null;
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    safeGet,
    extractTextContent,
    sanitizeTimestamp,
    generateFilename,
    deepSearchForProperty
  };
}

