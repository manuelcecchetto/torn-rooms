// A room's chat panel: the same markup as Torn's faction/global panels.
import { LIMITS, type AccessView, type MessageView, type RoomView } from '../../../shared/protocol';
import { api } from '../api';
import { ago, cx, fill, h, icon, linkify, retryIcon, roomIcon, tct, tctDay, text, type Child } from '../dom';
import type { IconName } from '../generated/icons';
import { closeRoom, deleteRoom, discard, join, leave, loadHistory, markRead, onRoomMessage, refreshRooms, retry, send, senderName, state, toggleRoom, type PendingMessage } from '../store';
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
  private footerTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly id: string) {
    this.el = h('div', { c: 'root___Ex8tg root___hrPnu visible___IVBmB root___IOJWq tr-panel', 'data-room': id });
    this.textarea = h('textarea', {
      c: 'textarea___JRbO5',
      placeholder: 'Type your message here...',
      maxlength: LIMITS.message,
      on: {
        keydown: (e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.submit();
          }
        },
        input: () => {
          this.syncSend();
          this.pingTyping();
        },
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
      if (this.scroller.clientHeight) this.pinned = this.atBottom();
      if (this.pinned && this.unseen) this.setUnseen(0);
      if (this.scroller.scrollTop < 40 && state.more.get(id) && !this.loading) this.loadOlder();
      if (this.atBottom()) markRead(id);
    });
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
    this.update();
    if (!state.messages.has(id) && state.rooms.get(id)?.joined) loadHistory(id).then(() => this.renderMessages(true), () => {});
    else this.renderMessages(true);
  }

  destroy(): void {
    this.unsub();
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
      const view: MessageView = { id: 0, roomId: p.roomId, userId: me?.id ?? 0, name: me?.name ?? '', avatar: null, factionTag: me?.factionTag ?? null, text: p.text, ts: p.ts };
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
    const body = h('span', { c: `root___XpplE body___HxuJg ${classic ? 'message___MITZq' : 'message___AI7Nl'}` }, h('span', { c: 'root___RoNAh' }, ...linkify(m.text)));
    return h(
      'div',
      { c: cx('virtualItem___eIUjo', classic && 'classic___S4LnO'), style: `margin-bottom: ${gap}px;` },
      h(
        'div',
        // Torn's pending style fades a message only when it is not confirmed within half a second.
        classic
          ? { c: cx('root___yvwp3', pending && 'pending___aZTtW'), title: tct(m.ts) }
          : { c: cx('root___EP_Dq', first && 'first___icNlg', self && 'self___HgXOK', pending && 'pending___aZTtW'), title: tct(m.ts) },
        classic
          ? h('div', { c: 'box___cZJah' }, h('span', {}, avatar, sender), body)
          : h('div', { c: 'box___eWW6m' }, h('span', { c: 'senderContainer___aAlZ2' }, avatar, sender), body),
        canDelete
          ? withClick(icon('closeChat', 'tr-del', 'Delete message'), () => {
              if (confirm('Delete this message for everyone?')) api('DELETE', `/v1/rooms/${this.id}/messages/${m.id}`).catch((e) => this.flash(e.message));
            })
          : null,
      ),
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

