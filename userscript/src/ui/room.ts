// A room's chat panel: the same markup as Torn's faction/global panels.
import { LIMITS, REACTIONS, type AccessView, type MessageView, type ReactionView, type RoomView } from '../../../shared/protocol';
import { api } from '../api';
import { ago, cx, fill, h, icon, linkify, retryIcon, roomIcon, tct, tctDay, text, type Child } from '../dom';
import type { IconName } from '../generated/icons';
import { closeRoom, deleteRoom, discard, join, leave, loadHistory, markRead, onReactions, onRoomMessage, react, refreshRooms, retry, seeMentions, send, senderName, state, tagsMe, toggleRoom, type PendingMessage } from '../store';
import { backView, info, parseTornId, setting, textInput, tornBtn, warning } from './forms';
import { roomForm } from './roomForm';
import defaultAvatar from '../../assets/avatar-default.jpg';

type View = 'chat' | 'members' | 'invite' | 'settings' | 'leave' | 'delete';

const GAP_MS = 15 * 60 * 1000;

export class RoomPanel {
  readonly el: HTMLElement;
  private header = h('div', { c: 'root___RdBC0' });
  /** faction tags and Torn's Bubbles / Avatars settings the messages were drawn with */
  private styleShown = '';
  /** Follow new messages: true while the reader is at the bottom (set by their scrolling, not re-measured). */
  private pinned = true;
  /** Messages from others that arrived while the reader was scrolled up: Torn's "↓ N new messages" pill. */
  private unseen = 0;
  /** The newest message in the list and its row: a new message after it is appended, not re-rendered. */
  private shown: MessageView | null = null;
  private shownRow: HTMLElement | null = null;
  private pill: HTMLElement | null = null;
  private content = h('div', { c: 'content___aMpKJ' });
  private scroller = h('div', { c: 'scrollWrapper___DmIrl' });
  private list = h('div', {});
  private pendingList = h('div', {});
  private footer = h('div', { c: 'footer___QxkWe' });
  private composerSlot = h('div', {});
  private textarea: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private overlay: HTMLElement | null = null;
  private view: View = 'chat';
  private menuOpen = false;
  private loading = false;
  private unsub: () => void;
  private unsubReactions: () => void;
  /** Each shown message's reactions row, by message id, to redraw just that row when they change. */
  private reactionRows = new Map<number, HTMLElement>();
  /** The open emoji picker: its message and how to close it. */
  private picker: { id: number; close: () => void } | null = null;
  /** Each confirmed message's hover tools and how to place them. */
  private toolsOf = new WeakMap<HTMLElement, { tools: HTMLElement; place: () => void }>();
  /** The message showing its tools under the pointer. */
  private hovered: HTMLElement | null = null;
  /** Where the pointer left the hovered message: while it heads from there to the tools, other messages keep out. */
  private exit: { x: number; y: number; at: number; dist: number } | null = null;
  private hoverTimer: ReturnType<typeof setTimeout> | undefined;
  /** Who reacted with one emoji, shown while the pointer is on its reaction. */
  private who: { id: number; emoji: string; el: HTMLElement } | null = null;
  private footerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Torn's blue pill again, "@ N mentions": jumps to the oldest message tagging you that you have not seen. */
  private atPill: HTMLElement | null = null;
  private atShown = 0;
  private jumping = false;
  /** Messages tagging you count as seen once on screen; these are the ones on it now. */
  private mentionWatch: IntersectionObserver;
  private mentionsInView = new Set<number>();
  private onVisible = () => this.seeVisibleMentions();
  /** The names offered while typing `@`: the room's members, fetched when first needed. */
  private suggest: { el: HTMLElement; start: number; query: string; items: Candidate[]; active: number } | null = null;
  private members: { at: number; list: Candidate[] } | null = null;
  private membersLoading = false;

  constructor(readonly id: string) {
    this.el = h('div', { c: 'root___Ex8tg root___hrPnu visible___IVBmB root___IOJWq tr-panel', 'data-room': id });
    this.textarea = h('textarea', {
      c: 'textarea___JRbO5',
      placeholder: 'Type your message here...',
      maxlength: LIMITS.message,
      on: {
        keydown: (e: KeyboardEvent) => {
          e.stopPropagation();
          if (this.suggest && !e.isComposing && this.suggestKey(e)) return;
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.submit();
          }
        },
        input: () => {
          this.syncSend();
          this.pingTyping();
          this.updateSuggest();
        },
        // The caret moved into or out of an @name.
        click: () => this.updateSuggest(),
        keyup: (e: KeyboardEvent) => ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && this.updateSuggest(),
        blur: () => this.closeSuggest(),
      },
    });
    this.sendBtn = h('button', { type: 'button', c: 'iconWrapper___DRSkm', on: { click: () => this.submit() } }, icon('send', 'icon___mMNXf'));
    this.composer = h('div', { c: 'root___aBCjE' }, this.textarea, this.sendBtn);
    // As in Torn, the "Last message" footer scrolls with the messages instead of taking a fixed strip.
    this.scroller.append(this.list, this.pendingList, this.footer);
    // A panel rendered before it is on screen (page load, minimized) has no height yet, so
    // scrolling to the newest message does nothing; redo it when the scroller gets its size.
    // The same when the messages grow after rendering (pictures, emoji fonts, the scrollbar appearing).
    const follow = new ResizeObserver(() => {
      if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    });
    follow.observe(this.scroller);
    follow.observe(this.list);
    follow.observe(this.pendingList);
    follow.observe(this.footer);
    this.scroller.addEventListener('scroll', () => {
      this.closePicker();
      if (this.scroller.clientHeight) this.pinned = this.atBottom();
      if (this.pinned && this.unseen) this.setUnseen(0);
      if (this.scroller.scrollTop < 40 && state.more.get(id) && !this.loading) this.loadOlder();
      if (this.atBottom()) markRead(id);
    });
    this.scroller.addEventListener('pointermove', (e) => this.trackHover(e));
    this.scroller.addEventListener('pointerleave', (e) => e.pointerType !== 'touch' && this.setHovered(null));
    // Half a message on screen is seen; a message taller than the panel counts once it fills half of it.
    this.mentionWatch = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = Number((e.target as HTMLElement).dataset.id);
          if (e.intersectionRatio >= 0.5 || (e.rootBounds && e.intersectionRect.height >= e.rootBounds.height / 2)) this.mentionsInView.add(id);
          else this.mentionsInView.delete(id);
        }
        this.seeVisibleMentions();
      },
      { root: this.scroller, threshold: [0, 0.25, 0.5, 0.75, 1] },
    );
    document.addEventListener('visibilitychange', this.onVisible);
    this.content.append(h('div', { c: 'root___v2RvA' }, this.scroller), this.composerSlot);
    this.el.append(this.header, this.content);
    this.unsub = onRoomMessage((roomId, msg) => {
      if (roomId !== id) return;
      const mine = !!msg && msg.userId === state.me?.id;
      if (msg && !mine && !this.pinned) this.setUnseen(this.unseen + 1);
      // Sending a message always brings you to it, as in Torn's chat.
      if (msg) this.appendMessage(msg, mine);
      else this.renderMessages();
    });
    this.unsubReactions = onReactions((roomId, msgId) => {
      const row = roomId === id && this.reactionRows.get(msgId);
      const m = row && state.messages.get(id)?.find((x) => x.id === msgId);
      if (row && m) this.fillReactions(row, m, true);
      // The chips were redrawn: keep the list on the one under the pointer, or drop it with its reaction.
      if (row && m && this.who?.id === msgId) {
        const chip = [...row.children].find((c) => (c as HTMLElement).dataset.emoji === this.who!.emoji) as HTMLElement | undefined;
        if (chip) this.showWho(m, this.who.emoji, chip);
        else this.hideWho();
      }
    });
    this.update();
    if (!state.messages.has(id) && state.rooms.get(id)?.joined) loadHistory(id).then(() => this.renderMessages(true), () => {});
    else this.renderMessages(true);
  }

  destroy(): void {
    this.unsub();
    this.unsubReactions();
    this.closePicker();
    this.closeSuggest();
    this.hideWho();
    this.mentionWatch.disconnect();
    document.removeEventListener('visibilitychange', this.onVisible);
    clearTimeout(this.hoverTimer);
    clearTimeout(this.footerTimer);
    this.el.remove();
  }

  private get room(): RoomView | undefined {
    return state.rooms.get(this.id);
  }

  /** Called on every store change: cheap parts only. */
  update(): void {
    const room = this.room;
    if (!room) return;
    this.renderHeader(room);
    this.renderComposer(room);
    this.renderPending();
    this.renderFooter();
    this.renderAt(room);
    this.seeVisibleMentions();
    const style = `${room.showFactionTags}:${state.chatStyle.bubbles}:${state.chatStyle.avatars}`;
    if (style !== this.styleShown) {
      this.styleShown = style;
      this.footer.className = cx('footer___QxkWe', !state.chatStyle.bubbles && 'classic___S4LnO');
      this.footerText = '';
      this.pendingKey = '';
      this.renderMessages();
      this.renderPending();
      this.renderFooter();
    }
    if (room.unread && this.atBottom() && document.visibilityState === 'visible') markRead(this.id);
  }

  // ---------------------------------------------------------------- header

  private renderHeader(room: RoomView): void {
    const options: [IconName, string, () => void][] = [];
    if (room.joined) options.push(['tabFriends', 'Members', () => this.show('members')]);
    if (room.role !== 'member') {
      options.push(['tabRecent', 'Invite', () => this.show('invite')]);
      options.push(['settings', 'Room settings', () => this.show('settings')]);
    }
    if (room.role === 'owner') options.push(['cross', 'Delete room', () => this.show('delete')]);
    else options.push(['leave', 'Leave room', () => this.show('leave')]);

    const unread = room.unread > 0;
    this.el.classList.toggle('tr-colored', !!room.color);
    if (room.color) this.el.style.setProperty('--tr-room', room.color);
    fill(
      this.header,
      h(
        'button',
        {
          type: 'button',
          c: cx('root___zZRe1 root___rnQAo header___cccSy', unread && 'message___g25GS'),
          // Like Torn's faction chat: a click on the header (not its title menu) minimizes the panel.
          on: {
            click: () => {
              this.menuOpen = false;
              toggleRoom(this.id);
            },
          },
        },
        h(
          'div',
          {
            c: cx('actionButton___CPUK5 enabled___Zme4G', this.menuOpen && 'actionButtonPressed___U2o81 actionButtonWithOpenOptions___Rntyl'),
            role: 'button',
            tabindex: '0',
            on: {
              click: (e: Event) => {
                e.stopPropagation();
                this.menuOpen = !this.menuOpen;
                this.renderHeader(room);
              },
            },
          },
          roomIcon(room.icon, 'icon___MBR1e'),
          text('headingH1', 'overflow___E0zcf title___ptIMK', { title: room.name, style: 'color: white;' }, room.name),
          icon('arrow', 'icon___MBR1e arrowIcon___RgJFw'),
        ),
        withClick(icon('minimize', 'icon___MBR1e minimizeIcon___Bk5cS', `Minimize ${room.name}`), () => toggleRoom(this.id)),
        // Like a private chat's X: the room leaves the chat bar and comes back from the Rooms panel.
        withClick(icon('closeChat', 'icon___MBR1e closeIcon___s4Gjc', `Close ${room.name}`), () => closeRoom(this.id)),
      ),
      this.menuOpen
        ? h(
            'div',
            { c: 'optionsContainer___CpJ5q' },
            options.map(([ic, title, run]) =>
              h(
                'button',
                {
                  type: 'button',
                  c: 'root___Lrh0J',
                  on: {
                    click: (e: Event) => {
                      e.stopPropagation();
                      this.menuOpen = false;
                      this.renderHeader(room);
                      run();
                    },
                  },
                },
                icon(ic, 'icon___DbWGg'),
                text('subtitle', 'title___oY9So', {}, title),
              ),
            ),
          )
        : null,
    );
  }

  // ---------------------------------------------------------------- messages

  /** Within about one message of the end counts as the bottom. */
  private atBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 60;
  }

  private toBottom(): void {
    this.pinned = true;
    this.scroller.scrollTop = this.scroller.scrollHeight;
    this.setUnseen(0);
  }

  private setUnseen(n: number): void {
    this.unseen = n;
    this.pill?.remove();
    this.pill = null;
    if (!n) return;
    const close = h('div', { role: 'presentation', c: 'closeButton___zQTHG' }, icon('closeChat', 'closeIcon___UMWK4', 'Dismiss new messages'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      this.setUnseen(0);
    });
    this.pill = h(
      'button',
      { type: 'button', c: 'root___XpplE subtitle___u4sr8 root___dtYq3', style: 'color: white;', on: { click: () => this.toBottom() } },
      arrowDown(),
      `${n} new message${n === 1 ? '' : 's'}`,
      close,
    );
    this.scroller.parentElement?.append(this.pill);
    this.atPill?.classList.toggle('tr-at-up', !!this.pill);
  }

  private async loadOlder(): Promise<void> {
    this.loading = true;
    const prevHeight = this.scroller.scrollHeight;
    try {
      await loadHistory(this.id, true);
      this.renderMessages();
      this.scroller.scrollTop += this.scroller.scrollHeight - prevHeight;
    } finally {
      this.loading = false;
    }
  }

  renderMessages(forceBottom = false): void {
    const stick = forceBottom || this.pinned || this.atBottom();
    const msgs = state.messages.get(this.id) ?? [];
    this.closePicker();
    this.hideWho();
    this.setHovered(null);
    this.reactionRows.clear();
    this.mentionWatch.disconnect();
    this.mentionsInView.clear();
    const items: HTMLElement[] = [];
    msgs.forEach((m, i) => items.push(...this.rows(m, msgs[i - 1], i < msgs.length - 1)));
    this.list.replaceChildren(...items);
    this.shown = msgs[msgs.length - 1] ?? null;
    this.shownRow = items[items.length - 1] ?? null;
    this.afterRender(stick);
  }

  /** A new newest message: one row added, like Torn's chat, instead of rebuilding the list. */
  private appendMessage(m: MessageView, mine: boolean): void {
    const msgs = state.messages.get(this.id) ?? [];
    const prev = msgs[msgs.length - 2];
    if (msgs[msgs.length - 1] !== m || !prev || prev !== this.shown || !this.shownRow) return this.renderMessages(mine);
    const stick = mine || this.pinned || this.atBottom();
    const rows = this.rows(m, prev, false);
    this.shownRow.style.marginBottom = `${rowGap()}px`;
    this.list.append(...rows);
    this.shown = m;
    this.shownRow = rows[rows.length - 1];
    this.afterRender(stick);
  }

  /** A message's rows: a time divider when a new group starts, then the message. As Torn: 5px between rows (6px without bubbles), 10px after the last one. */
  private rows(m: MessageView, prev: MessageView | undefined, hasNext: boolean, pending?: PendingMessage): HTMLElement[] {
    const rows: HTMLElement[] = [];
    const newGroup = !prev || m.ts - prev.ts > GAP_MS || tctDay(prev.ts) !== tctDay(m.ts);
    if (newGroup) rows.push(h('div', { c: cx('virtualItem___eIUjo', !state.chatStyle.bubbles && 'classic___S4LnO'), style: `margin-bottom: ${rowGap()}px;` }, text('divider2', 'root___Pai0M messageGroupTimestamp___Aag0t', {}, this.stamp(m.ts))));
    const first = newGroup || prev.userId !== m.userId;
    rows.push(this.message(m, first, m.userId === state.me?.id, hasNext ? rowGap() : 10, pending));
    return rows;
  }

  private pendingKey = '';

  /** Our messages the server has not confirmed yet, after the confirmed ones. */
  private renderPending(): void {
    const pending = state.pending.filter((p) => p.roomId === this.id);
    const key = pending.map((p) => `${p.reqId}:${p.failed}`).join();
    if (key === this.pendingKey) return;
    this.pendingKey = key;
    const me = state.me;
    let prev = (state.messages.get(this.id) ?? []).at(-1);
    const rows: HTMLElement[] = [];
    pending.forEach((p, i) => {
      const view: MessageView = { id: 0, roomId: p.roomId, userId: me?.id ?? 0, name: me?.name ?? '', avatar: null, factionTag: me?.factionTag ?? null, text: p.text, ts: p.ts, reactions: [], mentions: [] };
      rows.push(...this.rows(view, prev, i < pending.length - 1, p));
      prev = view;
    });
    const stick = this.pinned || this.atBottom();
    this.pendingList.replaceChildren(...rows);
    if (this.shownRow) this.shownRow.style.marginBottom = `${pending.length ? rowGap() : 10}px`;
    if (stick) this.toBottom();
  }

  private afterRender(stick: boolean): void {
    if (this.shownRow && state.pending.some((p) => p.roomId === this.id)) this.shownRow.style.marginBottom = `${rowGap()}px`;
    this.renderFooter();
    if (stick) {
      this.toBottom();
      if (document.visibilityState === 'visible' && state.expanded.has(this.id)) markRead(this.id);
    }
  }

  private stamp(ts: number): string {
    const today = tctDay(Date.now());
    const day = tctDay(ts);
    return day === today ? tct(ts) : `${day} ${tct(ts)}`;
  }

  private message(m: MessageView, first: boolean, self: boolean, gap: number, pending?: PendingMessage): HTMLElement {
    const profile = `/profiles.php?XID=${m.userId}`;
    const canDelete = !pending && (self || (this.room?.role ?? 'member') !== 'member');
    // Torn's chat settings: without bubbles a message is a classic line ("Name: text", the same for
    // your own), without avatars it has no picture.
    const classic = !state.chatStyle.bubbles;
    const avatar = state.chatStyle.avatars
      ? h('a', { 'data-label': 'avatar', href: profile, c: `root___uxEGq redirect___lSgmf smallWrapper___QAAkH ${classic ? 'avatar___b8bkC' : 'avatar___DTfNY'}` }, avatarImg(m.avatar, 'avatar___PYHqr smallAvatar___UPIO2'))
      : null;
    const sender = text('link2', `hrefLink___9O1GI ${classic ? 'sender___wV_Ae' : 'sender___WTwPl'} regular___hyk3H clickable___efRv1`, { href: profile }, `${senderName(this.room, m)}:`);
    const body = h('span', { c: `root___XpplE body___HxuJg ${classic ? 'message___MITZq' : 'message___AI7Nl'}` }, h('span', { c: 'root___RoNAh' }, ...linkify(m.text, m.mentions, state.me?.id)));
    const bubble = h(
      'div',
      // Torn's pending style fades a message only when it is not confirmed within half a second.
      classic
        ? { c: cx('root___yvwp3', pending && 'pending___aZTtW') }
        : { c: cx('root___EP_Dq', first && 'first___icNlg', self && 'self___HgXOK', pending && 'pending___aZTtW') },
      classic
        ? h('div', { c: 'box___cZJah' }, h('span', {}, avatar, sender), body)
        : h('div', { c: 'box___eWW6m' }, h('span', { c: 'senderContainer___aAlZ2' }, avatar, sender), body),
    );
    if (!pending) {
      // In the bubble's bottom right corner: after the text when the line has room, else on a line of their own.
      const reactions = h('div', { c: 'tr-reactions' });
      this.reactionRows.set(m.id, reactions);
      this.fillReactions(reactions, m);
      bubble.append(reactions, this.tools(m, bubble, canDelete));
    }
    const row = h(
      'div',
      { c: cx('virtualItem___eIUjo', classic && 'classic___S4LnO'), style: `margin-bottom: ${gap}px;`, 'data-id': pending ? undefined : m.id },
      bubble,
      pending?.failed
        ? h(
            'div',
            { c: cx('root___dwjU1', !classic && 'alignEnd___zwJTZ') },
            text('body', 'message___RIM_x', {}, 'Not sent'),
            text('link2', 'action___fg5Sc', { on: { click: () => retry(pending).catch((e) => this.flash(e.message)) } }, retryIcon('icon___NEsJp'), 'Retry'),
            text('link2', 'action___fg5Sc', { on: { click: () => discard(pending) } }, 'Delete'),
          )
        : null,
    );
    if (!pending && tagsMe(m)) this.mentionWatch.observe(row);
    return row;
  }

  // ---------------------------------------------------------------- mentions

  /** Over the "new messages" pill when both show; its X counts the mentions as seen. */
  private renderAt(room: RoomView): void {
    const n = room.joined ? (room.mentions ?? []).length : 0;
    if (n === this.atShown) return;
    this.atShown = n;
    this.atPill?.remove();
    this.atPill = null;
    if (!n) return;
    const close = h('div', { role: 'presentation', c: 'closeButton___zQTHG' }, icon('closeChat', 'closeIcon___UMWK4', 'Dismiss mentions'));
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      seeMentions(this.id, this.room?.mentions ?? []);
    });
    this.atPill = h(
      'button',
      { type: 'button', c: cx('root___XpplE subtitle___u4sr8 root___dtYq3 tr-at-pill', this.pill && 'tr-at-up'), style: 'color: white;', title: 'Go to the message tagging you', on: { click: () => this.jumpToMention() } },
      h('span', { c: 'tr-at-sign' }, '@'),
      `${n > 99 ? '99+' : n} mention${n === 1 ? '' : 's'}`,
      close,
    );
    this.scroller.parentElement?.append(this.atPill);
  }

  /** Unseen mentions on screen, while the page is looked at, are seen. */
  private seeVisibleMentions(): void {
    if (!this.mentionsInView.size || document.visibilityState !== 'visible') return;
    const ids = (this.room?.mentions ?? []).filter((id) => this.mentionsInView.has(id));
    if (ids.length) seeMentions(this.id, ids);
  }

  /** The @ button: to the oldest unseen message tagging you, loading older history until it is there. */
  private async jumpToMention(): Promise<void> {
    const target = this.room?.mentions?.[0];
    if (!target || this.jumping) return;
    this.jumping = this.loading = true;
    try {
      let loaded = false;
      for (let pages = 0; pages < MAX_JUMP_PAGES; pages++) {
        const list = state.messages.get(this.id);
        if (list && (list.some((m) => m.id === target) || !list.length || list[0].id < target || !state.more.get(this.id))) break;
        await loadHistory(this.id, !!list);
        loaded = true;
      }
      if (loaded) this.renderMessages();
      const row = this.list.querySelector<HTMLElement>(`[data-id="${target}"]`);
      // Deleted, or too far back to load: nothing to go to.
      seeMentions(this.id, [target]);
      if (row) this.scrollToRow(row);
    } catch (e) {
      this.flash((e as Error).message);
    } finally {
      this.jumping = this.loading = false;
    }
  }

  /** Brings a message to the middle of the panel (smoothly for the last screen of the way) and makes it flash. */
  private scrollToRow(row: HTMLElement): void {
    const s = this.scroller;
    const top = () => s.scrollTop + row.getBoundingClientRect().top - s.getBoundingClientRect().top - Math.max(8, (s.clientHeight - row.offsetHeight) / 2);
    this.pinned = false;
    if (Math.abs(top() - s.scrollTop) > s.clientHeight) s.scrollTop = top() + (top() < s.scrollTop ? s.clientHeight : -s.clientHeight);
    s.scrollTo({ top: top(), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    const bubble = row.querySelector<HTMLElement>('.tr_root___EP_Dq, .tr_root___yvwp3');
    if (!bubble) return;
    bubble.classList.remove('tr-flash');
    void bubble.offsetWidth; // restart the animation
    bubble.classList.add('tr-flash');
    bubble.addEventListener('animationend', (e) => e.target === bubble && bubble.classList.remove('tr-flash'), { once: true });
  }

  // ---------------------------------------------------------------- @name suggestions

  /** The `@name` being typed right before the caret. */
  private mentionAtCaret(): { start: number; query: string } | null {
    const ta = this.textarea;
    if (ta.selectionStart !== ta.selectionEnd) return null;
    const before = ta.value.slice(0, ta.selectionStart);
    const m = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_-]{0,32})$/.exec(before);
    return m ? { start: before.length - m[1].length - 1, query: m[1] } : null;
  }

  private updateSuggest(): void {
    const at = this.room?.canPost ? this.mentionAtCaret() : null;
    if (!at) return this.closeSuggest();
    this.loadMembers();
    const items = this.candidates(at.query);
    if (!items.length) return this.closeSuggest();
    // The highlight stays on its name while the list only refreshes (members arriving); a new query starts at the best match.
    const prev = this.suggest?.query === at.query ? this.suggest.items[this.suggest.active]?.id : undefined;
    const el = this.suggest?.el ?? h('div', { c: 'tr-suggest', role: 'listbox', on: { pointerdown: (e: Event) => e.preventDefault() } });
    this.suggest = { el, start: at.start, query: at.query, items, active: Math.max(0, items.findIndex((u) => u.id === prev)) };
    this.paintSuggest();
    if (!el.isConnected) this.scroller.parentElement?.append(el);
  }

  private paintSuggest(): void {
    const s = this.suggest;
    if (!s) return;
    fill(
      s.el,
      s.items.map((u, i) =>
        h(
          'div',
          {
            c: cx('tr-suggest-item', i === s.active && 'tr-suggest-on'),
            role: 'option',
            'aria-selected': String(i === s.active),
            on: {
              click: () => this.pick(u),
              pointermove: () => {
                if (s.active === i) return;
                s.active = i;
                this.paintSuggest();
              },
            },
          },
          h('span', { c: 'tr-suggest-name' }, ...matched(u.name, s.query)),
          h('span', { c: 'tr-suggest-id' }, `[${u.id}]`),
        ),
      ),
    );
  }

  /** Arrows move through the names, Enter or Tab picks one, Escape closes the list. */
  private suggestKey(e: KeyboardEvent): boolean {
    const s = this.suggest!;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      s.active = (s.active + (e.key === 'ArrowDown' ? 1 : -1) + s.items.length) % s.items.length;
      this.paintSuggest();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') this.pick(s.items[s.active]);
    else if (e.key === 'Escape') this.closeSuggest();
    else return false;
    e.preventDefault();
    return true;
  }

  /** Replaces the `@name` being typed with the picked player's name and a space. */
  private pick(u: Candidate): void {
    const s = this.suggest;
    if (!s) return;
    const ta = this.textarea;
    const spaced = /^\s/.test(ta.value.slice(ta.selectionStart));
    ta.setRangeText(`@${u.name}${spaced ? '' : ' '}`, s.start, ta.selectionStart, 'end');
    if (spaced) ta.setSelectionRange(ta.selectionStart + 1, ta.selectionStart + 1);
    this.closeSuggest();
    this.syncSend();
  }

  private closeSuggest(): void {
    this.suggest?.el.remove();
    this.suggest = null;
  }

  /** The room's members (asked again after a minute), refreshing the open list when they arrive. */
  private loadMembers(): void {
    if (this.membersLoading || (this.members && Date.now() - this.members.at < 60_000)) return;
    this.membersLoading = true;
    api<AccessView>('GET', `/v1/rooms/${this.id}/access`)
      .then(
        (a) => (this.members = { at: Date.now(), list: a.members.map((m) => ({ id: m.id, name: m.name })) }),
        () => (this.members = { at: Date.now(), list: this.members?.list ?? [] }),
      )
      .finally(() => {
        this.membersLoading = false;
        if (this.suggest) this.updateSuggest();
      });
  }

  /** Members matching what follows the @, not you: names starting with it first, then who spoke last, then A to Z. */
  private candidates(query: string): Candidate[] {
    const msgs = state.messages.get(this.id) ?? [];
    const spoke = new Map<number, number>();
    msgs.forEach((m, i) => spoke.set(m.userId, i));
    // Until the member list arrives, the people in the loaded messages.
    const people = new Map<number, string>((this.members?.list ?? msgs.map((m) => ({ id: m.userId, name: m.name }))).map((u) => [u.id, u.name]));
    people.delete(state.me?.id ?? 0);
    const q = query.toLowerCase();
    return [...people]
      .map(([id, name]) => ({ id, name, lower: name.toLowerCase() }))
      .filter((u) => u.lower.includes(q))
      .sort((a, b) => Number(b.lower.startsWith(q)) - Number(a.lower.startsWith(q)) || (spoke.get(b.id) ?? -1) - (spoke.get(a.id) ?? -1) || a.lower.localeCompare(b.lower))
      .slice(0, SUGGEST_MAX)
      .map(({ id, name }) => ({ id, name }));
  }

  /**
   * What hovering a message shows: its time, the reaction bubble, and Delete when allowed. Beside the
   * message when there is room, else over its top corner; a tap shows it on touch screens.
   */
  private tools(m: MessageView, bubble: HTMLElement, canDelete: boolean): HTMLElement {
    const reactBtn = this.room?.joined
      ? h('button', { type: 'button', c: 'tr-tools-react', title: 'React', 'aria-label': 'React' }, smileyIcon())
      : null;
    reactBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.picker?.id === m.id) this.closePicker();
      else this.openPicker(m, bubble, reactBtn);
    });
    const tools = h(
      'div',
      { c: 'tr-tools' },
      h('span', { c: 'tr-tools-time' }, this.stamp(m.ts)),
      reactBtn,
      canDelete
        ? withClick(icon('closeChat', 'tr-tools-del', 'Delete message'), () => {
            if (confirm('Delete this message for everyone?')) api('DELETE', `/v1/rooms/${this.id}/messages/${m.id}`).catch((e) => this.flash(e.message));
          })
        : null,
    );
    bubble.tabIndex = -1;
    const place = () => {
      const b = bubble.getBoundingClientRect();
      const s = this.scroller.getBoundingClientRect();
      const free = bubble.classList.contains('tr_self___HgXOK') ? b.left - s.left : s.left + this.scroller.clientWidth - b.right;
      bubble.classList.toggle('tr-tools-over', free < tools.offsetWidth + 8);
    };
    bubble.addEventListener('focusin', place);
    this.toolsOf.set(bubble, { tools, place });
    return tools;
  }

  /**
   * Hover with a safe triangle, as in menus: after the pointer leaves the hovered message, it keeps
   * its tools while it moves inside the triangle from where it left to the tools, or keeps getting
   * closer to them on a curved path (for AIM_MS at most), so crossing a gap or a neighbouring message
   * on the way does not hide them. Moving away from them hands the hover over at once.
   */
  private trackHover(e: PointerEvent): void {
    if (e.pointerType === 'touch') return;
    const bubble = this.bubbleAt(e.target as Element | null);
    if (bubble === this.hovered) {
      this.exit = null;
      clearTimeout(this.hoverTimer);
      return;
    }
    const tools = this.hovered && this.toolsOf.get(this.hovered)?.tools;
    if (tools) {
      const now = performance.now();
      const r = tools.getBoundingClientRect();
      const dist = Math.hypot(Math.max(r.left - e.clientX, 0, e.clientX - r.right), Math.max(r.top - e.clientY, 0, e.clientY - r.bottom));
      this.exit ??= { x: e.clientX, y: e.clientY, at: now, dist };
      const closer = dist <= this.exit.dist + 1;
      this.exit.dist = Math.min(this.exit.dist, dist);
      if (now - this.exit.at < AIM_MS && (closer || towards(this.exit, r, e.clientX, e.clientY))) {
        // Still on the way; if the pointer stops short of the tools, the message under it takes over.
        const { clientX: x, clientY: y } = e;
        clearTimeout(this.hoverTimer);
        this.hoverTimer = setTimeout(() => this.setHovered(this.bubbleAt(document.elementFromPoint(x, y))), AIM_MS);
        return;
      }
    }
    this.setHovered(bubble);
  }

  /** The message whose row is under the pointer: its whole width counts, so the tools beside a message are inside its hover. */
  private bubbleAt(el: Element | null): HTMLElement | null {
    const item = el?.closest('.tr_virtualItem___eIUjo');
    const bubble = item?.querySelector<HTMLElement>(':scope > .tr_root___EP_Dq, :scope > .tr_root___yvwp3') ?? null;
    return bubble && this.toolsOf.has(bubble) && this.list.contains(bubble) ? bubble : null;
  }

  private setHovered(bubble: HTMLElement | null): void {
    clearTimeout(this.hoverTimer);
    this.exit = null;
    if (bubble === this.hovered) return;
    this.hovered?.classList.remove('tr-hover');
    this.hovered = bubble;
    if (!bubble) return;
    bubble.classList.add('tr-hover');
    this.toolsOf.get(bubble)?.place();
  }

  private openPicker(m: MessageView, bubble: HTMLElement, anchor: HTMLElement): void {
    this.closePicker();
    const mine = new Set((m.reactions ?? []).filter((r) => r.users.some((u) => u.id === state.me?.id)).map((r) => r.emoji));
    const picker = h(
      'div',
      { c: 'tr-picker', role: 'menu' },
      REACTIONS.map((emoji) =>
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            c: cx('tr-pick', mine.has(emoji) && 'tr-pick-on'),
            on: {
              click: (e: Event) => {
                e.stopPropagation();
                this.closePicker();
                react(this.id, m.id, emoji).catch((err) => this.flash(err.message));
              },
            },
          },
          emoji,
        ),
      ),
    );
    this.el.append(picker);
    bubble.classList.add('tr-picking');
    // Above the bubble button, or below it when the header is in the way; inside the panel.
    const a = anchor.getBoundingClientRect();
    const p = this.el.getBoundingClientRect();
    const top = this.header.getBoundingClientRect().bottom;
    const left = Math.min(Math.max(4, a.left + a.width / 2 - picker.offsetWidth / 2 - p.left), p.width - picker.offsetWidth - 4);
    picker.style.left = `${left}px`;
    picker.style.top = `${a.top - picker.offsetHeight - 4 >= top ? a.top - p.top - picker.offsetHeight - 4 : a.bottom - p.top + 4}px`;
    const outside = (e: Event) => {
      if (!picker.contains(e.target as Node) && !anchor.contains(e.target as Node)) this.closePicker();
    };
    const escape = (e: KeyboardEvent) => e.key === 'Escape' && this.closePicker();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    this.picker = {
      id: m.id,
      close: () => {
        document.removeEventListener('pointerdown', outside, true);
        document.removeEventListener('keydown', escape, true);
        bubble.classList.remove('tr-picking');
        picker.remove();
      },
    };
  }

  private closePicker(): void {
    this.picker?.close();
    this.picker = null;
  }

  /**
   * A message's reactions: emoji and count, highlighted when one is ours; a click adds or takes
   * back ours. On a change (`animate`), an emoji that just got a reaction plays its animation.
   */
  private fillReactions(row: HTMLElement, m: MessageView, animate = false): void {
    const joined = !!this.room?.joined;
    // The server confirming what is already shown changes nothing, and must not restart an animation.
    const key = JSON.stringify([joined, state.me?.id, (m.reactions ?? []).map((r) => [r.emoji, r.users.map((u) => u.id)])]);
    if (row.dataset.key === key) return;
    row.dataset.key = key;
    const before = new Map([...row.children].map((c) => [(c as HTMLElement).dataset.emoji, Number((c as HTMLElement).dataset.count)]));
    fill(
      row,
      (m.reactions ?? []).map((r) =>
        h(
          'button',
          {
            type: 'button',
            c: cx('tr-chip', r.users.some((u) => u.id === state.me?.id) && 'tr-chip-on', animate && r.users.length > (before.get(r.emoji) ?? 0) && 'tr-chip-pop'),
            'data-emoji': r.emoji,
            'data-count': r.users.length,
            'aria-label': `${reactedBy(r)} reacted with ${r.emoji}`,
            disabled: !joined,
            on: {
              click: () => react(this.id, m.id, r.emoji).catch((e) => this.flash(e.message)),
              pointerenter: (e: PointerEvent) => {
                const shown = e.pointerType !== 'touch' && state.messages.get(this.id)?.find((x) => x.id === m.id);
                if (shown) this.showWho(shown, r.emoji, e.currentTarget as HTMLElement);
              },
              pointerleave: () => this.who?.id === m.id && this.who.emoji === r.emoji && this.hideWho(),
            },
          },
          h('span', { c: 'tr-chip-emoji', 'data-anim': REACTION_ANIMATIONS[r.emoji] ?? 'pop' }, r.emoji),
          h('span', { c: 'tr-chip-count' }, r.users.length),
        ),
      ),
    );
  }

  /** Who reacted with one emoji, above its reaction (below it when the header is in the way). */
  private showWho(m: MessageView, emoji: string, chip: HTMLElement): void {
    const reaction = m.reactions?.find((r) => r.emoji === emoji);
    if (!reaction) return this.hideWho();
    const el = this.who?.el ?? h('div', { c: 'tr-who', role: 'tooltip' });
    // Each name on its line, you first; a long list ends in "and N more".
    const names = reaction.users.map((u) => (u.id === state.me?.id ? 'You' : u.name)).sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
    fill(
      el,
      h('div', { c: 'tr-who-head' }, h('span', { c: 'tr-who-emoji' }, emoji), `${names.length}`),
      names.slice(0, WHO_MAX).map((n) => h('div', {}, n)),
      names.length > WHO_MAX ? h('div', { c: 'tr-who-more' }, `and ${names.length - WHO_MAX} more`) : null,
    );
    if (!el.isConnected) this.el.append(el);
    this.who = { id: m.id, emoji, el };
    const r = chip.getBoundingClientRect();
    const p = this.el.getBoundingClientRect();
    const top = this.header.getBoundingClientRect().bottom;
    el.style.left = `${Math.min(Math.max(4, r.left + r.width / 2 - p.left - el.offsetWidth / 2), p.width - el.offsetWidth - 4)}px`;
    el.style.top = `${r.top - el.offsetHeight - 4 >= top ? r.top - p.top - el.offsetHeight - 4 : r.bottom - p.top + 4}px`;
  }

  private hideWho(): void {
    this.who?.el.remove();
    this.who = null;
  }

  private footerText = '';

  private renderFooter(): void {
    const last = this.room?.lastMessage;
    const age = last ? Date.now() - last.ts : 0;
    // As Torn: who is typing; else "Last message" once the last message is a minute old, refreshed on each full minute since it was sent.
    const typing = typingLabel((state.typing.get(this.id) ?? []).map((u) => u.name));
    const line = typing || (last && age >= 60_000 ? `Last message: ${ago(last.ts)}` : '');
    // Only when the line changes, so the typing dots keep flashing through other updates.
    if (line !== this.footerText) {
      this.footerText = line;
      this.footer.replaceChildren(
        typing
          ? h('div', { c: 'root___XpplE divider2___nG653 root___koA3y typingIndicator___Lo_wW visible___geRbO' }, h('div', { c: 'root___gGAMB' }), typing)
          : line
            ? text('divider2', 'root___Pai0M lastMessageTimeInfo___XV7Vj', {}, line)
            : '',
      );
    }
    clearTimeout(this.footerTimer);
    if (last) this.footerTimer = setTimeout(() => this.renderFooter(), 60_000 - (Math.max(0, age) % 60_000) + 50);
  }

  // ---------------------------------------------------------------- composer

  private typingSent = 0;

  /** While there is text: a typing ping at most every few seconds. */
  private pingTyping(): void {
    const now = Date.now();
    if (!this.textarea.value.trim() || now - this.typingSent < LIMITS.typingPingMs) return;
    this.typingSent = now;
    api('POST', `/v1/rooms/${this.id}/typing`).catch(() => {});
  }

  private syncSend(): void {
    this.sendBtn.disabled = !this.textarea.value.trim();
  }

  private composerKey = '';
  private composer: HTMLElement;

  /** Swaps the composer for a notice only when the reason changes, so typing keeps focus. */
  private renderComposer(room: RoomView): void {
    const key = !room.joined ? 'invite' : state.conn !== 'live' ? state.conn : !room.canPost ? 'readonly' : 'compose';
    if (key !== this.composerKey) {
      this.composerKey = key;
      this.composerSlot.replaceChildren(
        key === 'invite'
          ? warning('Accept the invitation to chat in this room', ' ', tornBtn('Accept', () => join(this.id).then(() => loadHistory(this.id)).then(() => this.renderMessages(true))))
          : key === 'offline'
            ? warning('Disconnected')
            : key === 'connecting'
              ? info('Connecting')
              : key === 'readonly'
                ? warning('Only admins can write in this room')
                : this.composer,
      );
    }
    this.syncSend();
  }

  private async submit(): Promise<void> {
    const value = this.textarea.value.trim();
    if (!value) return;
    this.closeSuggest();
    this.textarea.value = '';
    this.typingSent = 0;
    this.syncSend();
    // Shown at once; a refusal leaves it as "Not sent" with Retry, as in Torn's chat.
    this.toBottom();
    await send(this.id, value).catch((e) => this.flash((e as Error).message));
  }

  private flashes = new Map<string, { strip: HTMLElement; timer: ReturnType<typeof setTimeout> }>();

  /** A warning above the composer for a few seconds; the same one again only restarts its time. */
  private flash(message: string): void {
    const shown = this.flashes.get(message);
    if (shown) clearTimeout(shown.timer);
    const strip = shown?.strip ?? warning(message);
    if (!shown) this.composerSlot.prepend(strip);
    const timer = setTimeout(() => {
      strip.remove();
      this.flashes.delete(message);
    }, 4000);
    this.flashes.set(message, { strip, timer });
  }

  // ---------------------------------------------------------------- sub-views

  private show(view: View): void {
    this.view = view;
    this.overlay?.remove();
    this.overlay = null;
    if (view === 'chat') return;
    const back = () => this.show('chat');
    const room = this.room!;
    let node: HTMLElement;
    if (view === 'settings') {
      node = roomForm({
        backTitle: 'Back to chat',
        submitTitle: 'Save',
        initial: { name: room.name, description: room.description, icon: room.icon, color: room.color, visibility: room.visibility, postPolicy: room.postPolicy, showFactionTags: room.showFactionTags },
        onBack: back,
        onSubmit: async (v) => {
          await api('PATCH', `/v1/rooms/${this.id}`, v);
          await refreshRooms();
          back();
        },
      });
    } else if (view === 'invite') node = this.inviteView(back);
    else if (view === 'members') node = this.membersView(back);
    else {
      const del = view === 'delete';
      node = backView('Back to chat', back, 'root___bdV8w', [
        text('body', 'message___V2QQb', {}, del ? `Delete ${room.name}? Every message in it is removed for everyone.` : `Leave ${room.name}? You can come back if you are invited again.`),
        h('div', { c: 'row___gsxrG', style: 'justify-content: center;' }, tornBtn(del ? 'Delete room' : 'Leave room', () => (del ? deleteRoom(this.id) : leave(this.id)).catch((e) => this.flash(e.message)))),
      ]);
    }
    this.overlay = node;
    this.content.append(node);
  }

  private inviteView(back: () => void): HTMLElement {
    const status = text('body', 'message___V2QQb', {}, '');
    const row = (placeholder: string, label: string, kind: 'player' | 'faction') => {
      const input = textInput({ placeholder, cls: 'input___hkebW', onEnter: () => go() });
      const go = async () => {
        const id = parseTornId(input.input.value);
        if (!id) return void (status.textContent = `That is not a ${kind} ID or link.`);
        status.textContent = 'Inviting…';
        try {
          const name = await tornName(kind, id);
          await api('POST', `/v1/rooms/${this.id}/grants`, { kind, id, label: name ?? undefined });
          input.input.value = '';
          status.textContent = `${name ?? `${kind === 'player' ? 'Player' : 'Faction'} #${id}`} is invited.`;
        } catch (e) {
          status.textContent = (e as Error).message;
        }
      };
      return h('div', { c: 'row___gsxrG' }, input.root, tornBtn(label, go));
    };
    return backView('Back to chat', back, 'root___bdV8w', [
      text('body', 'message___V2QQb', {}, 'Invite a player, or a whole faction: everyone in it gets the room, and loses it on leaving the faction. IDs or profile links work.'),
      row('Player ID', 'Invite', 'player'),
      row('Faction ID', 'Invite', 'faction'),
      status,
    ]);
  }

  private membersView(back: () => void): HTMLElement {
    const body = h('div', { c: 'tr-scroll', style: 'flex: 1;' }, info('Loading'));
    const room = this.room!;
    const manage = room.role !== 'member';
    const draw = async () => {
      try {
        const a = await api<AccessView>('GET', `/v1/rooms/${this.id}/access`);
        const act = (label: string, run: () => Promise<unknown>) =>
          text('link1', 'hrefLink___9O1GI tr-act', { href: '#', on: { click: (e: Event) => (e.preventDefault(), run().then(draw, (err) => alert(err.message))) } }, label);
        const line = (...children: Child[]) => h('div', { c: 'tr-line' }, ...children);
        const profile = (id: number, name: string) => text('link1', 'hrefLink___9O1GI', { href: `/profiles.php?XID=${id}` }, `${name} [${id}]`);
        // A personal invite stays as the joined player's access, but is no longer pending: it moves to their member row.
        const joined = new Set(a.members.map((m) => m.id));
        const personal = new Set(a.grants.filter((g) => g.kind === 'player').map((g) => g.id));
        const pending = a.grants.filter((g) => g.kind !== 'player' || !joined.has(g.id));
        const removeGrant = (kind: string, id: number) => act('Remove', () => api('DELETE', `/v1/rooms/${this.id}/grants/${kind}/${id}`));
        fill(
          body,
          setting(`Members (${a.members.length})`, [
            ...a.members.map((m) =>
              line(
                profile(m.id, m.name),
                m.role !== 'member' ? text('body', 'tr-role', {}, m.role) : null,
                room.role === 'owner' && m.role !== 'owner'
                  ? act(m.role === 'admin' ? 'Demote' : 'Make admin', () => api(m.role === 'admin' ? 'DELETE' : 'POST', `/v1/rooms/${this.id}/admins/${m.id}`))
                  : null,
                manage && m.role === 'member' && personal.has(m.id) ? removeGrant('player', m.id) : null,
                manage && m.role === 'member' ? act('Ban', () => api('POST', `/v1/rooms/${this.id}/bans/${m.id}`, { label: m.name })) : null,
              ),
            ),
          ]),
          setting('Invited', [
            ...(pending.length ? [] : [text('body', '', {}, room.visibility === 'public' ? 'Public room: anyone can join.' : 'Nobody yet.')]),
            ...pending.map((g) =>
              line(
                g.kind === 'faction'
                  ? text('link1', 'hrefLink___9O1GI', { href: `/factions.php?step=profile&ID=${g.id}` }, `${g.label} [${g.id}]`)
                  : profile(g.id, g.label),
                text('body', 'tr-role', {}, g.kind),
                manage ? removeGrant(g.kind, g.id) : null,
              ),
            ),
          ]),
          manage && a.bans.length
            ? setting('Banned', a.bans.map((b) => line(profile(b.id, b.label), act('Unban', () => api('DELETE', `/v1/rooms/${this.id}/bans/${b.id}`)))))
            : null,
        );
      } catch (e) {
        body.replaceChildren(warning((e as Error).message));
      }
    };
    draw();
    return backView('Back to chat', back, '', [body]);
  }
}

interface Candidate {
  id: number;
  name: string;
}

/** Names the @ list offers at once. */
const SUGGEST_MAX = 6;

/** History pages the @ button loads at most to reach a mention (50 messages each). */
const MAX_JUMP_PAGES = 40;

/** A name with the part matching the typed query in bold. */
function matched(name: string, query: string): Child[] {
  const i = query ? name.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (i < 0) return [name];
  return [name.slice(0, i), h('b', {}, name.slice(i, i + query.length)), name.slice(i + query.length)];
}

/** Names listed when hovering a reaction before "and N more". */
const WHO_MAX = 12;

/** Which animation each reaction plays when it goes in (keyframes in extra.css). */
const REACTION_ANIMATIONS: Record<string, string> = { '👍': 'thumb', '❤️': 'heart', '😂': 'laugh', '😮': 'wow', '😢': 'sad', '🔥': 'fire' };

/** How long the pointer may take from a message to its tools. */
const AIM_MS = 500;

/** Is (x, y) inside the area between the point the pointer left from and the tools (their convex hull)? The tools count 10px larger, for curved paths. */
function towards(from: { x: number; y: number }, tools: DOMRect, x: number, y: number): boolean {
  const r = { left: tools.left - 10, top: tools.top - 10, right: tools.right + 10, bottom: tools.bottom + 10 };
  if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
  const corners: [number, number][] = [[r.left, r.top], [r.right, r.top], [r.right, r.bottom], [r.left, r.bottom]];
  return corners.some((a, i) => inTriangle(x, y, from.x, from.y, a, corners[(i + 1) % 4]));
}

function inTriangle(x: number, y: number, px: number, py: number, [ax, ay]: [number, number], [bx, by]: [number, number]): boolean {
  const side = (x1: number, y1: number, x2: number, y2: number) => (x - x2) * (y1 - y2) - (x1 - x2) * (y - y2);
  const d1 = side(px, py, ax, ay);
  const d2 = side(ax, ay, bx, by);
  const d3 = side(bx, by, px, py);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/** "You, Ghost and Foxy", at most eight names, then "and N more". */
function reactedBy(r: ReactionView): string {
  const names = r.users.map((u) => (u.id === state.me?.id ? 'You' : u.name)).sort((a, b) => (a === 'You' ? -1 : b === 'You' ? 1 : 0));
  const shown = names.length > 8 ? [...names.slice(0, 8), `${names.length - 8} more`] : names;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
}

/** The reaction bubble's icon: a smiling face. */
function smileyIcon(): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 16 16');
  el.setAttribute('width', '14');
  el.setAttribute('height', '14');
  // constant markup, never user content
  el.innerHTML =
    '<circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="5.7" cy="6.4" r="1" fill="currentColor"/><circle cx="10.3" cy="6.4" r="1" fill="currentColor"/><path d="M4.9 9.4a3.4 3.4 0 0 0 6.2 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';
  return el;
}

/** Torn's space between message rows: 6px in its classic (no bubbles) style, else 5px. */
const rowGap = () => (state.chatStyle.bubbles ? 5 : 6);

/** Torn's typing indicator text. */
function typingLabel(names: string[]): string {
  if (names.length === 0) return '';
  if (names.length === 1) return `${names[0]} is typing...`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing...`;
  return 'Several people are typing...';
}

/** Torn's avatar rule: the player's picture, or Torn's default when missing or broken. */
// Torn's default avatar, bundled as a data URL so the script never requests anything from torn.com.
const DEFAULT_AVATAR = defaultAvatar;
function avatarImg(src: string | null, cls: string): HTMLImageElement {
  const img = h('img', { alt: 'avatar', c: cls, src: src || DEFAULT_AVATAR });
  img.addEventListener('error', () => {
    if (img.src !== DEFAULT_AVATAR) img.src = DEFAULT_AVATAR;
  }, { once: true });
  return img;
}

/** Looks up a player's or faction's name with the user's own key, for invite labels. */
function tornName(kind: 'player' | 'faction', id: number): Promise<string | null> {
  const key = GM_getValue<string>('apiKey', '');
  const path = kind === 'player' ? `user/${id}/basic` : `faction/${id}/basic`;
  return new Promise((resolve) => {
    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://api.torn.com/v2/${path}?key=${encodeURIComponent(key)}&comment=torn-rooms`,
      timeout: 10_000,
      onload: (r) => {
        try {
          const d = JSON.parse(r.responseText);
          resolve((kind === 'player' ? d.profile?.name : d.basic?.name) ?? null);
        } catch {
          resolve(null);
        }
      },
      onerror: () => resolve(null),
      ontimeout: () => resolve(null),
    });
  });
}

function withClick<T extends Element>(el: T, run: () => void): T {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return el;
}

/** Torn's "new messages" arrow (Font Awesome arrow-down, white). */
function arrowDown(): SVGSVGElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 384 512');
  el.setAttribute('height', '14');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M169.4 470.6c12.5 12.5 32.8 12.5 45.3 0l160-160c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 370.8 224 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 306.7L54.6 265.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160z');
  path.setAttribute('fill', 'white');
  el.append(path);
  return el;
}

