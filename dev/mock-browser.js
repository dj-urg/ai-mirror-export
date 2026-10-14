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

  const EXPORT_OUTCOME = 'success';

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
    supported_ready_google_ai_mode: {
      tab: FIXTURES.tabs.google_ai_mode,
      conversationsResponse: FIXTURES.conversations.google_ai_mode
    },
    supported_ready_perplexity: {
      tab: FIXTURES.tabs.perplexity,
      conversationsResponse: FIXTURES.conversations.perplexity
    },
    supported_ready_grok: {
      tab: FIXTURES.tabs.grok,
      conversationsResponse: FIXTURES.conversations.grok
    },
    supported_ready_deepseek: {
      tab: FIXTURES.tabs.deepseek,
      conversationsResponse: FIXTURES.conversations.deepseek
    },
    supported_ready_mistral: {
      tab: FIXTURES.tabs.mistral,
      conversationsResponse: FIXTURES.conversations.mistral
    },
    supported_ready_m365_copilot: {
      tab: FIXTURES.tabs.m365_copilot,
      conversationsResponse: FIXTURES.conversations.m365_copilot_ready
    },
    // Idle: on a supported site, nothing captured yet.
    supported_idle_claude: {
      tab: FIXTURES.tabs.claude,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_copilot: {
      tab: FIXTURES.tabs.copilot,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_perplexity: {
      tab: FIXTURES.tabs.perplexity,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_grok: {
      tab: FIXTURES.tabs.grok,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_deepseek: {
      tab: FIXTURES.tabs.deepseek,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_mistral: {
      tab: FIXTURES.tabs.mistral,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_idle_m365_copilot: {
      tab: FIXTURES.tabs.m365_copilot,
      conversationsResponse: FIXTURES.conversations.empty
    },
    supported_replying_m365_copilot: {
      tab: FIXTURES.tabs.m365_copilot,
      conversationsResponse: FIXTURES.conversations.m365_copilot_replying
    },
    supported_idle_chatgpt: {
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
    },
    auth_failed_deepseek: {
      tab: FIXTURES.tabs.deepseek,
      conversationsResponse: FIXTURES.conversations.empty,
      authFailed: { platform: 'deepseek', where: 'history_messages' }
    },
    // Export outcomes rendered as presets so the baseline can capture them.
    // harness.js clicks Export after load; the outcome drives the mock.
    export_result_success: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'success_result'
    },
    export_result_success_study_code: {
      // Same, with a study code set: the review copy mentions the researcher.
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      storage: { study_salt: 'STUDY-42' },
      autoExport: 'success_result'
    },
    export_result_download_failed: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'download_failed'
    },
    export_result_processing_failed: {
      tab: FIXTURES.tabs.claude,
      conversationsResponse: FIXTURES.conversations.claude,
      autoExport: 'processing_failed'
    },
    export_result_empty_export: {
      tab: FIXTURES.tabs.claude,
      conversationsResponse: FIXTURES.conversations.claude,
      autoExport: 'empty_export'
    },
    export_result_invalid_data: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'invalid_data'
    },
    export_no_data: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'no_data'
    },
    export_failed: {
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'export_failed'
    },
    export_rate_limited: {
      // Two clicks within two seconds trip popup.js's own rate limiter.
      tab: FIXTURES.tabs.chatgpt,
      conversationsResponse: FIXTURES.conversations.chatgpt,
      autoExport: 'rate_limit'
    }
  };

  // Expose the preset table so harness.js can read autoExport without
  // duplicating it.
  window.__HARNESS_STATE_MAP__ = STATE_MAP;

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

  // runtime.onMessage listeners registered by popup.js. background.js
  // broadcasts EXPORT_RESULT through this channel, so the mock must be able
  // to deliver one for the export-outcome presets to render.
  const runtimeListeners = [];
  function dispatchRuntimeMessage(message) {
    const sender = { id: 'ai-chat-exporter@harness' };
    for (const fn of runtimeListeners) {
      try { fn(message, sender, () => {}); } catch (_) { /* popup handles its own errors */ }
    }
  }
  function broadcastExportResult(detail, delayMs = 400) {
    setTimeout(() => dispatchRuntimeMessage({ type: 'EXPORT_RESULT', detail }), delayMs);
  }

  const outcome = (typeof window.__HARNESS_EXPORT_OUTCOME__ === 'string')
    ? window.__HARNESS_EXPORT_OUTCOME__
    : (currentState().autoExport || EXPORT_OUTCOME);

  function handleExport() {
    const ok = (delay = 350) => new Promise((resolve) => setTimeout(() => resolve({ success: true }), delay));
    switch (outcome) {
      case 'hang':
        // Keep the Exporting… state visible forever.
        return new Promise(() => {});
      case 'rate_limit':
        // First click fails fast so the button is re-enabled; harness.js
        // then clicks again inside popup.js's two-second window.
        return Promise.resolve({ success: false, error: 'Something went wrong while exporting' });
      case 'network_error':
        // tabs.sendMessage rejected with something other than "Receiving
        // end does not exist" → popup shows NETWORK_ERROR.
        return Promise.reject(new Error('fetch failed'));
      case 'content_script_missing':
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      case 'no_data':
        // Content script answers, but has nothing for this conversation.
        return Promise.resolve({ success: false, error: 'No data available for this conversation' });
      case 'export_failed':
        // Content script answers with a generic failure.
        return Promise.resolve({ success: false, error: 'Something went wrong while exporting' });
      case 'download_failed':
        broadcastExportResult({ platform: 'chatgpt', outcome: 'download_failed', reason: 'Download failed', filename: 'chatgpt_synthetic_2026-01-01T00-00-00Z.zip' });
        return ok();
      case 'processing_failed':
        broadcastExportResult({ platform: 'claude', outcome: 'processing_failed', reason: 'Processing failed' });
        return ok();
      case 'empty_export':
        broadcastExportResult({ platform: 'claude', outcome: 'empty_export', code: 'EMPTY', reason: 'Claude chat_messages array is empty' });
        return ok();
      case 'invalid_data':
        broadcastExportResult({ platform: 'chatgpt', outcome: 'invalid_data', code: 'BAD_SHAPE', reason: 'ChatGPT mapping is not a plain object' });
        return ok();
      case 'success_result':
        broadcastExportResult({ platform: 'chatgpt', outcome: 'success', filename: 'chatgpt_synthetic_2026-01-01T00-00-00Z.zip', downloadId: 1 });
        return ok();
      case 'success':
      default:
        // Simulate a brief delay so the Exporting… state is visible.
        return ok();
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
      onMessage: {
        addListener: (fn) => { if (typeof fn === 'function') runtimeListeners.push(fn); },
        removeListener: (fn) => {
          const i = runtimeListeners.indexOf(fn);
          if (i >= 0) runtimeListeners.splice(i, 1);
        }
      },
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
      },
      show: (downloadId) => {
        try { window.parent?.postMessage({ type: 'HARNESS_DOWNLOADS_SHOW', downloadId }, '*'); } catch (_) {}
        return Promise.resolve();
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
