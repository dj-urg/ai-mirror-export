/**
 * Synthetic conversation fixtures for the preview harness.
 *
 * All data here is fabricated. Never put a real conversation in this file.
 */

const FIXTURES = {
  // Tab shapes per supported state. tab.status === 'complete' unless noted.
  tabs: {
    chatgpt: {
      id: 101,
      url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000abc',
      status: 'complete',
      title: 'Synthetic ChatGPT conversation'
    },
    claude: {
      id: 102,
      url: 'https://claude.ai/chat/00000000-0000-4000-8000-000000000cla',
      status: 'complete',
      title: 'Synthetic Claude conversation'
    },
    copilot: {
      id: 103,
      url: 'https://copilot.microsoft.com/chats/00000000-0000-4000-8000-000000cop',
      status: 'complete',
      title: 'Synthetic Copilot conversation'
    },
    google_overview: {
      id: 104,
      url: 'https://www.google.com/search?q=how+do+ocean+currents+work',
      status: 'complete',
      title: 'Google — how do ocean currents work'
    },
    google_ai_mode: {
      id: 105,
      url: 'https://www.google.com/search?q=explain+plate+tectonics&udm=50',
      status: 'complete',
      title: 'Google AI Mode — explain plate tectonics'
    },
    unsupported: {
      id: 999,
      url: 'https://example.org/some-article',
      status: 'complete',
      title: 'Unsupported page'
    },
    about_blank: {
      id: 998,
      url: 'about:blank',
      status: 'complete',
      title: ''
    },
    loading: {
      id: 101,
      url: 'https://chatgpt.com/c/00000000-0000-4000-8000-000000000abc',
      status: 'loading',
      title: 'Loading…'
    },
    chatgpt_no_id: {
      id: 110,
      url: 'https://chatgpt.com/',
      status: 'complete',
      title: 'ChatGPT home'
    }
  },

  // Response shapes returned by tabs.sendMessage(GET_CAPTURED_CONVERSATIONS).
  // Fields are intentionally minimal — matching what checkConversationData reads.
  conversations: {
    chatgpt: {
      success: true,
      conversations: [
        {
          id: '00000000-0000-4000-8000-000000000abc',
          title: 'How tides work'
        }
      ]
    },
    claude: {
      success: true,
      conversations: [
        {
          id: '00000000-0000-4000-8000-000000000cla',
          title: 'Writing feedback on a paper'
        }
      ]
    },
    copilot: {
      success: true,
      conversations: [
        {
          id: '00000000-0000-4000-8000-000000cop',
          title: 'Trip planning: Lisbon'
        }
      ]
    },
    google_overview: {
      success: true,
      conversations: [
        {
          id: 'how do ocean currents work::overview',
          title: 'how do ocean currents work'
        }
      ]
    },
    google_ai_mode_capturing: {
      success: true,
      conversations: [
        {
          id: 'explain plate tectonics::ai_mode',
          title: 'explain plate tectonics',
          turnCount: 2
        }
      ]
    },
    empty: {
      success: true,
      conversations: []
    },
    no_overview_for_page: {
      success: true,
      conversations: [],
      noOverviewForThisPage: true
    }
  }
};

window.__HARNESS_FIXTURES__ = FIXTURES;
