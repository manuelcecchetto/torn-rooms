// Torn Rooms: extra chat rooms inside Torn's chat bar.
import tornCss from './generated/torn-chat.css';
import extraCss from './extra.css';
import { hasKey, logout, openEvents, session, storedSession } from './api';
import { changed, handleEvent, setError, state, subscribe, syncChatStyle } from './store';
import { Layout } from './ui/layout';

function waitForChat(): Promise<void> {
  return new Promise((resolve) => {
    const ready = () => document.querySelector('#chatRoot [class*="root___Ef1Ql"]');
    if (ready()) return resolve();
    const obs = new MutationObserver(() => {
      if (ready()) {
        obs.disconnect();
        resolve();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  });
}

let stopEvents: (() => void) | null = null;

async function start(): Promise<void> {
  let s = storedSession();
  if (!s && hasKey()) {
    try {
      s = await session();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (!s) {
    state.me = null;
    changed();
    return;
  }
  state.me = s.me;
  setError(null);
  changed();
  stopEvents?.();
  stopEvents = openEvents(
    () => [...state.expanded],
    handleEvent,
    (conn) => {
      state.conn = conn;
      changed();
    },
  );
}

async function boot(): Promise<void> {
  document.documentElement.dataset.tornRooms = __VERSION__;
  await waitForChat();
  // Follow the player's Torn chat styling, also when they change it in Torn's chat settings. Read only
  // while the Torn tab is actively viewed (visible and focused), like everything taken from the page.
  const syncIfActive = () => document.visibilityState === 'visible' && document.hasFocus() && syncChatStyle();
  syncIfActive();
  window.addEventListener('focus', syncIfActive);
  setInterval(syncIfActive, 2000);
  const style = document.createElement('style');
  style.textContent = tornCss + '\n' + extraCss;
  document.head.append(style);
  const layout = new Layout(
    () => start(),
    () => {
      stopEvents?.();
      stopEvents = null;
      logout();
      state.me = null;
      state.rooms.clear();
      state.messages.clear();
      state.open = [];
      state.expanded.clear();
      changed();
    },
  );
  subscribe(() => layout.render());
  layout.render();
  await start();
}

boot();
