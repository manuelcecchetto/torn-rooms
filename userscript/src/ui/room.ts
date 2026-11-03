// A room's chat panel: the same markup as Torn's faction/global panels.
import { LIMITS, type AccessView, type MessageView, type RoomView } from '../../../shared/protocol';
import { api } from '../api';
import { ago, cx, fill, h, icon, linkify, roomIcon, tct, tctDay, text, type Child } from '../dom';
import type { IconName } from '../generated/icons';
import { deleteRoom, join, leave, loadHistory, markRead, onRoomMessage, refreshRooms, send, senderName, state, toggleRoom } from '../store';
import { backView, info, parseTornId, setting, textInput, tornBtn, warning } from './forms';
import { roomForm } from './roomForm';
import defaultAvatar from '../../assets/avatar-default.jpg';

type View = 'chat' | 'members' | 'invite' | 'settings' | 'leave' | 'delete';

const GAP_MS = 15 * 60 * 1000;

export class RoomPanel {
  readonly el: HTMLElement;
  private header = h('div', { c: 'root___RdBC0' });
  private tagsShown = false;
  /** Stay on the newest message while the panel is resized or shown. */
  private pinned = true;
  private content = h('div', { c: 'content___aMpKJ' });
  private scroller = h('div', { c: 'scrollWrapper___DmIrl' });
  private list = h('div', {});
  private footer = h('div', { c: 'footer___QxkWe' });
  private composerSlot = h('div', {});
  private textarea: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private overlay: HTMLElement | null = null;
  private view: View = 'chat';
  private menuOpen = false;
  private loading = false;
  private unsub: () => void;
  private ticker: ReturnType<typeof setInterval>;

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
        input: () => this.syncSend(),
      },
    });
    this.sendBtn = h('button', { type: 'button', c: 'iconWrapper___DRSkm', on: { click: () => this.submit() } }, icon('send', 'icon___mMNXf'));
    this.composer = h('div', { c: 'root___aBCjE' }, this.textarea, this.sendBtn);
    this.scroller.append(this.list);
    // A panel rendered before it is on screen (page load, minimized) has no height yet, so
    // scrolling to the newest message does nothing; redo it when the scroller gets its size.
    new ResizeObserver(() => {
      if (this.pinned) this.scroller.scrollTop = this.scroller.scrollHeight;
    }).observe(this.scroller);
    this.scroller.addEventListener('scroll', () => {
      if (this.scroller.clientHeight) this.pinned = this.atBottom();
      if (this.scroller.scrollTop < 40 && state.more.get(id) && !this.loading) this.loadOlder();
      if (this.atBottom()) markRead(id);
    });
    this.content.append(h('div', { c: 'root___v2RvA' }, this.scroller, this.footer), this.composerSlot);
    this.el.append(this.header, this.content);
    this.unsub = onRoomMessage((roomId) => {
      if (roomId === id) this.renderMessages();
    });
    this.ticker = setInterval(() => this.renderFooter(), 30_000);
    this.update();
    if (!state.messages.has(id) && state.rooms.get(id)?.joined) loadHistory(id).then(() => this.renderMessages(true), () => {});
    else this.renderMessages(true);
  }

  destroy(): void {
    this.unsub();
    clearInterval(this.ticker);
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
    this.renderFooter();
    if (room.showFactionTags !== this.tagsShown) {
      this.tagsShown = room.showFactionTags;
      this.renderMessages();
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

  private atBottom(): boolean {
    return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < 30;
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
    const stick = forceBottom || this.atBottom();
    const msgs = state.messages.get(this.id) ?? [];
    const meId = state.me?.id;
    const items: Child[] = [];
    msgs.forEach((m, i) => {
      const prev = msgs[i - 1];
      const next = msgs[i + 1];
      const newGroup = !prev || m.ts - prev.ts > GAP_MS || tctDay(prev.ts) !== tctDay(m.ts);
      if (newGroup) items.push(h('div', { c: 'virtualItem___eIUjo', style: 'margin-bottom: 5px;' }, text('divider2', 'root___Pai0M messageGroupTimestamp___Aag0t', {}, this.stamp(m.ts))));
      const first = newGroup || prev.userId !== m.userId;
      const nextOther = !next || next.userId !== m.userId;
      items.push(this.message(m, first, m.userId === meId, nextOther ? 10 : 5));
    });
    this.list.replaceChildren(...(items as Node[]));
    this.renderFooter();
    if (stick) {
      this.pinned = true;
      this.scroller.scrollTop = this.scroller.scrollHeight;
      if (document.visibilityState === 'visible' && state.expanded.has(this.id)) markRead(this.id);
    }
  }

  private stamp(ts: number): string {
    const today = tctDay(Date.now());
    const day = tctDay(ts);
    return day === today ? tct(ts) : `${day} ${tct(ts)}`;
  }

  private message(m: MessageView, first: boolean, self: boolean, gap: number): HTMLElement {
    const profile = `/profiles.php?XID=${m.userId}`;
    const canDelete = self || (this.room?.role ?? 'member') !== 'member';
    return h(
      'div',
      { c: 'virtualItem___eIUjo', style: `margin-bottom: ${gap}px;` },
      h(
        'div',
        { c: cx('root___EP_Dq', first && 'first___icNlg', self && 'self___HgXOK'), title: tct(m.ts) },
        h(
          'div',
          { c: 'box___eWW6m' },
          h(
            'span',
            { c: 'senderContainer___aAlZ2' },
            h('a', { 'data-label': 'avatar', href: profile, c: 'root___uxEGq redirect___lSgmf smallWrapper___QAAkH avatar___DTfNY' }, avatarImg(m.avatar, 'avatar___PYHqr smallAvatar___UPIO2')),
            text('link2', 'hrefLink___9O1GI sender___WTwPl regular___hyk3H clickable___efRv1', { href: profile }, `${senderName(this.room, m)}:`),
          ),
          h('span', { c: 'root___XpplE body___HxuJg message___AI7Nl' }, h('span', { c: 'root___RoNAh' }, ...linkify(m.text))),
        ),
        canDelete
          ? withClick(icon('closeChat', 'tr-del', 'Delete message'), () => {
              if (confirm('Delete this message for everyone?')) api('DELETE', `/v1/rooms/${this.id}/messages/${m.id}`).catch((e) => this.flash(e.message));
            })
          : null,
      ),
    );
  }

  private renderFooter(): void {
    const last = this.room?.lastMessage;
    this.footer.replaceChildren(last ? text('divider2', 'root___Pai0M lastMessageTimeInfo___XV7Vj', {}, `Last message: ${ago(last.ts)}`) : '');
  }

  // ---------------------------------------------------------------- composer

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
    this.syncSend();
    try {
      await send(this.id, value);
      this.renderMessages(true);
    } catch (e) {
      this.textarea.value = value;
      this.syncSend();
      this.flash((e as Error).message);
    }
  }

  private flash(message: string): void {
    const strip = warning(message);
    this.composerSlot.prepend(strip);
    setTimeout(() => strip.remove(), 4000);
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
                manage && m.role === 'member' ? act('Ban', () => api('POST', `/v1/rooms/${this.id}/bans/${m.id}`, { label: m.name })) : null,
              ),
            ),
          ]),
          setting('Invited', [
            ...(a.grants.length ? [] : [text('body', '', {}, room.visibility === 'public' ? 'Public room: anyone can join.' : 'Nobody yet.')]),
            ...a.grants.map((g) =>
              line(
                g.kind === 'faction'
                  ? text('link1', 'hrefLink___9O1GI', { href: `/factions.php?step=profile&ID=${g.id}` }, `${g.label} [${g.id}]`)
                  : profile(g.id, g.label),
                text('body', 'tr-role', {}, g.kind),
                manage ? act('Remove', () => api('DELETE', `/v1/rooms/${this.id}/grants/${g.kind}/${g.id}`)) : null,
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
