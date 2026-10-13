/**
 * Mock `window.browser` for the preview harness.
 *
 * Must load as a classic (blocking) script BEFORE popup.js so the extension
 * finds `browser.*` the moment it runs. The harness page injects this ahead
 * of the shared scripts via a <base> + srcdoc trick.
 *
 * State comes from window.__HARNESS_STATE__ (preset) and can be overridden
 * for an interactive export outcome by window.__HARNESS_EXPORT_OUTCOME__.
 */

(function initMockBrowser() {
  const STATE = typeof window.__HARNESS_STATE__ === 'string'
    ? window.__HARNESS_STATE__
    : 'supported_ready_chatgpt';

  const EXPORT_OUTCOME = typeof window.__HARNESS_EXPORT_OUTCOME__ === 'string'
    ? window.__HARNESS_EXPORT_OUTCOME__
    : 'success';

  const FIXTURES = window.__HARNESS_FIXTURES__ || { tabs: {}, conversations: {} };

  // Map each state preset to its mock behavior. Everything a state can control
  // lives here so adding a new state is one entry.
  const STATE_MAP = {
    consent_first_run: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      storage: { consent_given: undefined }
    },
    supported_ready_chatgpt: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt
    },
    supported_ready_claude: {
      tab: FIXTURES.tabs.claude,
      conversationsResponse: FIXTURES.conversations.claude
    },
    supported_ready_copilot: {
      tab: FIXTURES.tabs.copilot,
      conversationsResponse: FIXTURES.conversations.copilot
    },
    supported_ready_google_overview: {
      tab: FIXTURES.tabs.google_overview,
      conversationsResponse: FIXTURES.conversations.google_overview
    },
    supported_ready_google_ai_mode_capturing: {
      tab: FIXTURES.tabs.google_ai_mode,
      conversationsResponse: FIXTURES.conversations.google_ai_mode_capturing
    },
    supported_loading_data: {
      // Supported URL, data not yet captured. popup.js shows "capturing..."
      // and after ~15s swaps to the reload prompt.
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.empty
    },
    loading_tab_navigating: {
      // tab.status === 'loading' → "Waiting for page to load…"
      tab: FIXTURES.tabs.loading,
      conversationsResponse: FIXTURES.conversations.empty
    },
    error_unsupported: {
      tab: FIXTURES.tabs.unsupported,
      conversationsResponse: FIXTURES.conversations.empty
    },
    error_no_conversation_id: {
      tab: FIXTURES.tabs.chatgpt_no_id,
      conversationsResponse: FIXTURES.conversations.empty
    },
    error_content_script_not_loaded: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponseError: 'Could not establish connection. Receiving end does not exist.'
    },
    error_no_data_google: {
      // Google-specific: content script responded but no overview on page
      tab: FIXTURES.tabs.google_overview,
      conversationsResponse: FIXTURES.conversations.no_overview_for_page
    },
    auth_failed_claude: {
      // "Popup opened after auth failure" — background still has the
      // stored authFailureByTab entry, so GET_AUTH_STATE returns it and
      // popup short-circuits to the sign-in card.
      tab: FIXTURES.tabs.claude,
      conversationsResponse: FIXTURES.conversations.empty,
      authFailed: { platform: 'claude', where: 'conversation' }
    }
  };

  function currentState() {
    return STATE_MAP[STATE] || STATE_MAP.supported_ready_chatgpt;
  }

  // Local, in-memory storage. Harness can seed via __HARNESS_STORAGE__.
  const storageSeed = Object.assign(
    { consent_given: true, pii_scrub_enabled: false, include_donor_context: true, study_salt: '' },
    currentState().storage || {},
    window.__HARNESS_STORAGE__ || {}
  );
  // Explicitly deleted keys (undefined) stay missing so popup.js sees "no value".
  for (const k of Object.keys(storageSeed)) {
    if (storageSeed[k] === undefined) delete storageSeed[k];
  }
  const localStore = { ...storageSeed };

  const noop = () => {};
  const asyncNoop = () => Promise.resolve();

  function storageGet(keys) {
    if (keys === null || keys === undefined) return Promise.resolve({ ...localStore });
    if (typeof keys === 'string') {
      return Promise.resolve(keys in localStore ? { [keys]: localStore[keys] } : {});
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) if (k in localStore) out[k] = localStore[k];
      return Promise.resolve(out);
    }
    // Object: keys = { a: default, b: default }
    const out = {};
    for (const k of Object.keys(keys)) {
      out[k] = (k in localStore) ? localStore[k] : keys[k];
    }
    return Promise.resolve(out);
  }

  function storageSet(obj) {
    Object.assign(localStore, obj || {});
    return Promise.resolve();
  }

  function tabsQuery() {
    const tab = currentState().tab || FIXTURES.tabs.chatgpt;
    return Promise.resolve([tab]);
  }

  function tabsSendMessage(_tabId, message) {
    const s = currentState();
    if (!message || typeof message !== 'object') return Promise.resolve({});

    if (message.type === 'GET_CAPTURED_CONVERSATIONS') {
      if (s.conversationsResponseError) {
        return Promise.reject(new Error(s.conversationsResponseError));
      }
      return Promise.resolve(s.conversationsResponse || { success: false });
    }

    if (message.type === 'EXPORT_CONVERSATION') {
      return handleExport();
    }

    // Default echo so unknown messages don't throw.
    return Promise.resolve({ success: true });
  }

  function handleExport() {
    switch (EXPORT_OUTCOME) {
      case 'hang':
        // Keep the Exporting… state visible forever.
        return new Promise(() => {});
      case 'network_error':
        return Promise.reject(new Error('NETWORK_ERROR: fetch failed'));
      case 'no_data':
        return Promise.reject(new Error('NO_DATA_AVAILABLE'));
      case 'rate_limit':
        return Promise.reject(new Error('EXPORT_FAILED: Rate limit exceeded'));
      case 'export_failed':
        return Promise.reject(new Error('EXPORT_FAILED: Something went wrong'));
      case 'success':
      default:
        // Simulate a brief delay so the Exporting… state is visible.
        return new Promise((resolve) => {
          setTimeout(() => resolve({ success: true }), 350);
        });
    }
  }

  // Icon state + badge: no-op but record so the harness can display them.
  const iconState = { icon: 'default', title: '', badgeText: '' };
  function setIcon(details) { iconState.icon = JSON.stringify(details); notifyParent(); return Promise.resolve(); }
  function setTitle(details) { iconState.title = details?.title || ''; notifyParent(); return Promise.resolve(); }
  function setBadgeText(details) { iconState.badgeText = details?.text || ''; notifyParent(); return Promise.resolve(); }

  function notifyParent() {
    try {
      window.parent?.postMessage({ type: 'HARNESS_ICON_UPDATE', iconState }, '*');
    } catch (_) { /* ignore cross-origin */ }
  }

  // Prevent popup.js's auto-close from killing the iframe window.
  const origClose = window.close.bind(window);
  window.close = function harnessCloseIntercept() {
    try {
      window.parent?.postMessage({ type: 'HARNESS_POPUP_CLOSE' }, '*');
    } catch (_) { /* ignore */ }
    // Visually dim so the user sees "the popup would close here".
    document.documentElement.setAttribute('data-harness-closed', 'true');
    return origClose;
  };

  // Minimal browser.* surface used by popup.js. Anything popup.js adds later
  // should be added here too — but keep the mock lean.
  window.browser = {
    tabs: {
      query: tabsQuery,
      sendMessage: tabsSendMessage,
      reload: () => {
        try { window.parent?.postMessage({ type: 'HARNESS_TAB_RELOAD' }, '*'); } catch (_) {}
        return Promise.resolve();
      },
      onUpdated: { addListener: noop, removeListener: noop },
      onActivated: { addListener: noop, removeListener: noop }
    },
    runtime: {
      id: 'ai-chat-exporter@harness',
      onMessage: { addListener: noop, removeListener: noop },
      // State-aware runtime.sendMessage so popup → background queries like
      // GET_AUTH_STATE return the right thing per harness preset.
      sendMessage: async (msg) => {
        const s = currentState();
        if (msg && msg.type === 'GET_AUTH_STATE') {
          if (s.authFailed) {
            return {
              authFailed: true,
              platform: s.authFailed.platform || 'claude',
              where: s.authFailed.where || null,
              since: Date.now() - 60000
            };
          }
          return { authFailed: false };
        }
        return { success: true };
      },
      getURL: (p) => new URL(p, document.baseURI).href,
      getManifest: () => ({ version: 'harness', name: 'AI Chat Exporter' })
    },
    storage: {
      local: { get: storageGet, set: storageSet, remove: asyncNoop, clear: asyncNoop },
      onChanged: { addListener: noop, removeListener: noop }
    },
    downloads: {
      download: (details) => {
        try { window.parent?.postMessage({ type: 'HARNESS_DOWNLOAD', details }, '*'); } catch (_) {}
        return Promise.resolve(1);
      }
    },
    action: {
      setIcon,
      setTitle,
      setBadgeText,
      setBadgeBackgroundColor: () => Promise.resolve()
    }
  };

  // Convenience: let the harness poke the popup to re-render without a full
  // reload. Fire checkAndUpdateUI if popup.js has exposed it (it doesn't by
  // default — current behavior: reload the frame for state changes).
  window.addEventListener('message', (ev) => {
    if (ev.data?.type === 'HARNESS_PING') {
      try { window.parent?.postMessage({ type: 'HARNESS_PONG' }, '*'); } catch (_) {}
    }
  });

  // Tell the parent we're wired up. Must be synchronous so the parent knows
  // the mock installed before popup.js runs.
  try { window.parent?.postMessage({ type: 'HARNESS_MOCK_READY', state: STATE }, '*'); } catch (_) {}
})();
