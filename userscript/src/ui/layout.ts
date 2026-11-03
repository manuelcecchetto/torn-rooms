// Puts our buttons into Torn's chat bar and our panels next to Torn's open panels.
// Panels are laid out like Torn's: stacked in one grid cell, each slid left with translateX and a
// 150ms linear transition, reorderable by dragging the header; bar buttons are reorderable too.
import { badge, cx, h, icon, roomIcon } from '../dom';
import { DIRECTORY, joinedRooms, minimizePanels, moveBarButton, movePanel, state, toggleDirectory, toggleRoom, visiblePanels } from '../store';
import { Directory } from './directory';
import { sortable } from './drag';
import { RoomPanel } from './room';

const PANEL_GAP = 3; // Torn spaces its 300px panels 303px apart
const BAR_HEIGHT = 38;
const BAR_GAP = 5;

/** Torn's chat settings: Height / Width sliders, in percent of 400 x 300. */
function panelSize(): { width: number; height: number } {
  let pct = { width: 100, height: 100 };
  try {
    pct = { ...pct, ...JSON.parse(localStorage.getItem('tchat:panel_size') ?? '{}') };
  } catch {
    // keep the defaults
  }
  return { width: Math.round((300 * pct.width) / 100), height: Math.round((400 * pct.height) / 100) };
}

/** A pointerdown that may start dragging a panel: on its header, not on its menu or inputs. */
const isPanelHandle = (t: Element) => !!t.closest('.tr_root___RdBC0, .tr-panel > .tr_root___zZRe1') && !t.closest('.tr_optionsContainer___CpJ5q, input, textarea');

export class Layout {
  private root = h('div', { c: 'tr-root' });
  private panels = h('div', { c: 'tr-panels' });
  private bar = h('div', { c: 'tr-bar' });
  private directory: Directory;
  private rooms = new Map<string, RoomPanel>();
  private offsets = new Map<string, number>();
  private dragging: string | null = null;
  private barDragging = false;
  private observer: MutationObserver;
  private frame = 0;
  private lastBar: HTMLElement | null = null;

  constructor(onLogin: () => void, onLogout: () => void) {
    this.directory = new Directory(onLogin, onLogout);
    this.bindPanelDrag(this.directory.el, DIRECTORY);
    this.root.append(this.panels);
    document.body.append(this.root);
    this.observer = new MutationObserver(() => this.schedule());
    this.watch();
    window.addEventListener('resize', () => this.schedule());
  }

  private watch(): void {
    const chat = document.getElementById('chatRoot');
    if (chat) this.observer.observe(chat, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.mountBar();
      this.position();
    });
  }

  /** Torn's bar is React-managed and re-renders; keep our buttons in it, before the Notes button. */
  private mountBar(): void {
    const tornBar = document.querySelector<HTMLElement>('#chatRoot [class*="root___Ef1Ql"]');
    if (!tornBar) return;
    const anchor = tornBar.querySelector('#notes_panel_button') ?? tornBar.querySelector('#people_panel_button');
    if (this.bar.parentElement !== tornBar || (anchor && this.bar.nextElementSibling !== anchor)) {
      this.observer.disconnect();
      tornBar.insertBefore(this.bar, anchor);
      this.watch();
    }
    this.lastBar = tornBar;
  }

  /** Our stack sits left of Torn's visible panels, on the same baseline; each panel slides to its slot. */
  private position(): void {
    let left = window.innerWidth - 5 + PANEL_GAP;
    for (const p of document.querySelectorAll<HTMLElement>('#chatRoot [class*="visible___"][class*="root___Ex8tg"]')) {
      const r = p.getBoundingClientRect();
      if (r.width > 0 && r.left < left) left = r.left;
    }
    const tornBar = this.lastBar?.getBoundingClientRect();
    const bottom = tornBar && tornBar.height ? window.innerHeight - tornBar.top + BAR_GAP : BAR_HEIGHT + BAR_GAP;
    this.root.style.right = `${Math.max(5, window.innerWidth - left + PANEL_GAP)}px`;
    this.root.style.bottom = `${bottom}px`;

    const size = panelSize();
    const room = left - PANEL_GAP - 5; // width left of Torn's panels
    let offset = 0;
    const overflow: string[] = [];
    this.offsets.clear();
    for (const key of visiblePanels()) {
      const el = this.panelEl(key);
      if (!el) continue;
      // Keep at least the rightmost panel; the rest must fit on screen.
      if (offset > 0 && offset + size.width > room && key !== this.dragging) {
        overflow.push(key);
        continue;
      }
      this.offsets.set(key, offset);
      el.style.width = `${size.width}px`;
      el.style.height = `${size.height}px`;
      if (key !== this.dragging) el.style.transform = `translateX(-${offset}px)`;
      offset += size.width + PANEL_GAP;
    }
    if (overflow.length && !this.dragging) minimizePanels(overflow);
  }

  private panelEl(key: string): HTMLElement | undefined {
    return key === DIRECTORY ? this.directory.el : this.rooms.get(key)?.el;
  }

  private bindPanelDrag(el: HTMLElement, key: string): void {
    sortable({
      el,
      key,
      axis: 'xy',
      canStart: isPanelHandle,
      base: () => `translateX(-${this.offsets.get(key) ?? 0}px)`,
      slots: () =>
        visiblePanels().flatMap((k) => {
          const r = this.panelEl(k)?.getBoundingClientRect();
          return r ? [{ key: k, center: r.left + r.width / 2 }] : [];
        }),
      onStart: () => (this.dragging = key),
      onEnd: (target) => {
        this.dragging = null;
        if (target) movePanel(key, target);
        this.position();
      },
    });
  }

  render(): void {
    if (!this.barDragging) this.renderBar();
    this.renderPanels();
    this.schedule();
  }

  private renderBar(): void {
    const buttons: HTMLElement[] = [];
    for (const id of state.open) {
      const room = state.rooms.get(id);
      if (!room) continue;
      const opened = state.expanded.has(id);
      const button = h(
        'button',
        {
          type: 'button',
          id: `tr_chat_panel_button:${id}`,
          title: room.name,
          c: cx('root___zZRe1 root___rnQAo root___y4L37', opened && 'opened___dihOy opened___PTx4p', room.unread > 0 && 'message___g25GS', room.color && 'tr-colored'),
          style: room.color ? `--tr-room: ${room.color}` : undefined,
          on: { click: () => toggleRoom(id) },
        },
        roomIcon(room.icon, cx('icon___vikBy', opened && 'opened___p8ZQ1')),
        badge('messageCount___db2PN', room.unread),
      );
      const wrap = h('div', { c: 'root___tV4zg tr-bar-item', 'data-room': id }, button);
      sortable({
        el: wrap,
        key: id,
        axis: 'x',
        canStart: () => true,
        base: () => '',
        slots: () =>
          [...this.bar.querySelectorAll<HTMLElement>('.tr-bar-item')].map((b) => {
            const r = b.getBoundingClientRect();
            return { key: b.dataset.room!, center: r.left + r.width / 2 };
          }),
        onStart: () => (this.barDragging = true),
        onEnd: (target) => {
          this.barDragging = false;
          wrap.style.transform = '';
          if (target) moveBarButton(id, target);
          else this.renderBar();
        },
      });
      buttons.push(wrap);
    }
    const unread = joinedRooms()
      .filter((r) => !state.open.includes(r.id))
      .reduce((n, r) => n + r.unread, 0);
    buttons.push(
      h(
        'button',
        {
          type: 'button',
          id: 'tr_rooms_panel_button',
          title: 'Rooms',
          c: cx('root___zZRe1 root___mRtyn', state.directory && 'opened___dihOy'),
          on: { click: () => toggleDirectory() },
        },
        icon('chats', cx('icon___aydeq', state.directory && 'opened___zdbFJ')),
        badge('messageCount___EWpiR', unread),
      ),
    );
    this.bar.replaceChildren(...buttons);
  }

  private renderPanels(): void {
    for (const [id, panel] of this.rooms) {
      if (!state.expanded.has(id) || !state.rooms.has(id)) {
        panel.destroy();
        this.rooms.delete(id);
      }
    }
    if (state.directory) this.directory.render();
    const wanted: HTMLElement[] = [];
    for (const key of visiblePanels()) {
      if (key === DIRECTORY) {
        wanted.push(this.directory.el);
        continue;
      }
      let panel = this.rooms.get(key);
      if (!panel) {
        panel = new RoomPanel(key);
        this.rooms.set(key, panel);
        this.bindPanelDrag(panel.el, key);
        // Start at its slot, then slide like Torn's panels do.
        panel.el.style.transform = `translateX(-${this.offsets.get(key) ?? 0}px)`;
      } else panel.update();
      wanted.push(panel.el);
    }
    // Panels share one grid cell, so DOM order never matters for layout: only add and remove.
    for (const el of [...this.panels.children]) if (!wanted.includes(el as HTMLElement)) el.remove();
    for (const el of wanted) if (el.parentElement !== this.panels) this.panels.append(el);
  }
}
