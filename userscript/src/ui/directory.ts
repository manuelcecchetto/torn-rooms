// The "Rooms" panel: Torn's People panel layout with rooms instead of private chats.
import { LIMITS, type BrowseRoom, type RoomView } from '../../../shared/protocol';
import { api, ApiError, login, setShowAvatar } from '../api';
import { ago, badge, componentIcon, cx, h, icon, roomIcon, text } from '../dom';
import type { IconName } from '../generated/icons';
import { invites, join, joinedRooms, openRoom, refreshRooms, senderName, setDirectoryTab, setError, setOwnAvatar, state, toggleDirectory, type DirectoryTab } from '../store';
import { actionButton, checkbox, setting, textInput, tornBtn, warning } from './forms';
import { roomForm } from './roomForm';

const KEY_URL = 'https://www.torn.com/preferences.php#tab=api?step=addNewKey&title=Torn%20Rooms&type=1';

export class Directory {
  readonly el = h('div', { c: 'root___Ex8tg root___hrPnu visible___IVBmB root___jByi5 tr-panel', id: 'tr_rooms_panel' });
  private search = '';
  private creating = false;
  private browse: BrowseRoom[] | null = null;
  private browseQuery = '';
  constructor(
    private onLogin: () => void,
    private onLogout: () => void,
  ) {}

  private header = h(
    'button',
    { type: 'button', c: 'root___zZRe1 root___tQsxi', on: { click: () => toggleDirectory(false) } },
    h('div', { c: 'textContainer___yU28H' }, icon('chats'), text('headingH1', '', { style: 'color: white;' }, 'Rooms')),
    withClick(icon('minimize', 'minimizeIcon___Qr0SL', 'Minimize Rooms'), () => toggleDirectory(false)),
  );
  private tabSlot = h('div', { style: 'display: contents;' });
  private body = h('div', { c: 'content___SMWAe' });
  private listSlot = h('div', { style: 'display: contents;' });
  private errorSlot = h('div', {});
  private mode = '';

  /** Re-renders tabs and lists on every change; inputs and forms are rebuilt only when the view changes. */
  render(): void {
    if (!this.el.firstChild) this.el.append(this.header, this.tabSlot, this.body);
    this.errorSlot.replaceChildren(state.error ? warning(state.error) : '');
    if (!state.me) {
      if (this.mode !== 'login') {
        this.mode = 'login';
        this.tabSlot.replaceChildren();
        this.body.replaceChildren(h('div', { c: 'tr-scroll' }, this.loginView()), this.errorSlot);
      }
      return;
    }
    const mode = this.creating ? 'create' : state.directoryTab;
    this.tabSlot.replaceChildren(this.tabBar());
    if (mode !== this.mode) {
      this.mode = mode;
      if (mode === 'create')
        this.body.replaceChildren(
          roomForm({
            backTitle: 'Back to rooms',
            submitTitle: 'Create new chat room',
            onBack: () => ((this.creating = false), this.render()),
            onSubmit: async (v) => {
              const room = await api<RoomView>('POST', '/v1/rooms', v);
              this.creating = false;
              await refreshRooms();
              openRoom(room.id);
            },
          }),
        );
      else if (mode === 'browse') this.body.replaceChildren(this.searchBox('Search public rooms', (q) => this.loadBrowse(q)), this.listSlot, this.errorSlot);
      else if (mode === 'settings') this.body.replaceChildren(h('div', { c: 'tr-scroll' }, this.settingsView()), this.errorSlot);
      else if (mode === 'rooms') this.body.replaceChildren(this.searchBox('Search your rooms', (q) => ((this.search = q), this.render())), this.listSlot, this.errorSlot);
      else this.body.replaceChildren(this.listSlot, this.errorSlot);
    }
    if (mode !== 'create' && mode !== 'settings') this.listSlot.replaceChildren(mode === 'browse' ? this.browseList() : this.roomList(mode === 'invites'));
    this.errorSlot.replaceChildren(state.error ? warning(state.error) : '');
  }

  private tabBar(): HTMLElement {
    const tabs: [DirectoryTab, IconName, string, number][] = [
      ['rooms', 'tabChats', 'Your rooms', joinedRooms().reduce((n, r) => n + r.unread, 0)],
      ['invites', 'tabFriends', 'Invitations', invites().length],
      ['browse', 'globe', 'Public rooms', 0],
      ['settings', 'settings', 'Settings', 0],
    ];
    return h(
      'div',
      { c: 'root___M9jgF' },
      tabs.flatMap(([id, ic, title, count], i) => [
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            title,
            c: cx('root___FDeLd', !this.creating && state.directoryTab === id && 'selected___f9h6Z'),
            on: {
              click: () => {
                this.creating = false;
                setDirectoryTab(id);
                if (id === 'browse') this.loadBrowse();
              },
            },
          },
          icon(ic, 'icon___mLyRZ'),
          badge('messageCount___jsC_Z', count),
        ),
        i < tabs.length - 1 ? h('div', { c: 'divider___yq6Xu' }) : null,
      ]),
    );
  }

  private searchBox(placeholder: string, onInput: (q: string) => void): HTMLElement {
    const box = textInput({ placeholder, icon: 'search', value: state.directoryTab === 'browse' ? this.browseQuery : this.search, onInput });
    return h('div', { c: 'root___wDVPW root___TNYGW' }, box.root);
  }

  private card(opts: { key: string; iconName: string; color?: string; title: string; metadata?: string; description: string; unread?: number; onClick: () => void; createIcon?: boolean }): HTMLElement {
    return h(
      'button',
      {
        type: 'button',
        c: `root___QOWpT tr-card ${opts.color ? 'tr-colored' : ''}`,
        id: `tr_room_card_${opts.key}`,
        style: opts.color ? `--tr-room: ${opts.color}` : undefined,
        on: { click: opts.onClick },
      },
      h('span', { c: 'root___uxEGq largeWrapper___i8ZDk tr-card-icon' }, opts.createIcon ? componentIcon('createRoom') : roomIcon(opts.iconName)),
      h(
        'div',
        { c: 'wrapper___pXMZO' },
        h('div', { c: 'header___PzxzT' }, text('link1', 'title___BsFVo regular___hyk3H', {}, opts.title), opts.metadata ? text('body', 'metadata___n5Pj2', {}, opts.metadata) : null),
        h('div', { c: 'content___LLeBK' }, text('body', 'description____safi', {}, h('span', { c: 'root___RoNAh' }, opts.description))),
        badge('messageCount___IqCpE', opts.unread ?? 0),
      ),
    );
  }

  private roomList(invitesOnly: boolean): HTMLElement {
    const q = this.search.toLowerCase();
    const rooms = (invitesOnly ? invites() : joinedRooms()).filter((r) => !q || r.name.toLowerCase().includes(q));
    const cards: HTMLElement[] = [];
    if (!invitesOnly && !q)
      cards.push(
        this.card({
          key: 'create',
          iconName: '',
          createIcon: true,
          title: 'Create New Chat Room',
          description: `Create your own chat room and invite players or whole factions (up to ${LIMITS.ownedRooms})`,
          onClick: () => ((this.creating = true), this.render()),
        }),
      );
    for (const r of rooms)
      cards.push(
        this.card({
          key: r.id,
          iconName: r.icon,
          color: r.color,
          title: r.name,
          metadata: r.lastMessage ? ago(r.lastMessage.ts) : invitesOnly ? 'invited' : '',
          description: r.lastMessage ? `${senderName(r, r.lastMessage)}: ${r.lastMessage.text}` : r.description || 'No messages yet',
          unread: r.unread,
          onClick: () => (r.joined ? openRoom(r.id) : join(r.id).catch((e) => alert(e.message))),
        }),
      );
    if (invitesOnly && !rooms.length) cards.push(text('body', 'tr-empty', {}, 'No invitations. When someone invites you or your faction, the room shows up here.'));
    return h('div', { c: 'root___nbZIu tr-scroll' }, h('div', { c: 'tr-list' }, cards), h('div', { c: 'footer___v_x_1' }));
  }

  private async loadBrowse(q = this.browseQuery): Promise<void> {
    this.browseQuery = q;
    try {
      const { rooms } = await api<{ rooms: BrowseRoom[] }>('GET', `/v1/rooms/browse?q=${encodeURIComponent(q)}`);
      if (q === this.browseQuery) {
        this.browse = rooms;
        this.render();
      }
    } catch (e) {
      state.error = (e as Error).message;
      this.render();
    }
  }

  private browseList(): HTMLElement {
    if (!this.browse) {
      this.loadBrowse();
      return h('div', { c: 'root___nbZIu' });
    }
    const cards = this.browse.map((r) =>
      this.card({
        key: `pub_${r.id}`,
        iconName: r.icon,
        color: r.color,
        title: r.name,
        metadata: `${r.memberCount} ${r.memberCount === 1 ? 'member' : 'members'}`,
        description: r.description || r.topic,
        onClick: () => (r.joined ? openRoom(r.id) : join(r.id).catch((e) => alert(e.message))),
      }),
    );
    if (!cards.length) cards.push(text('body', 'tr-empty', {}, this.browseQuery ? 'No results found' : 'No public rooms yet.'));
    return h('div', { c: 'root___nbZIu tr-scroll' }, h('div', { c: 'tr-list' }, cards), h('div', { c: 'footer___v_x_1' }));
  }

  private settingsView(): HTMLElement {
    const me = state.me!;
    const status = text('body', '', { style: 'margin-top: 6px;' }, '');
    const consent = avatarCheckbox(me.showAvatar, async (show) => {
      consent.input.disabled = true;
      try {
        await setShowAvatar(show);
        setOwnAvatar(show);
        status.textContent = show ? 'Your picture now shows next to your messages.' : 'Your picture is removed, also from your past messages.';
      } catch (e) {
        consent.input.checked = !show;
        status.textContent = (e as Error).message;
      } finally {
        consent.input.disabled = false;
      }
    });
    return h(
      'div',
      {},
      setting('Profile picture', [
        consent.label,
        text('body', '', { style: 'margin-top: 6px; opacity: 0.8;' }, 'Off by default. When off, the server keeps no link to your picture and others see Torn\'s default avatar.'),
        status,
      ]),
      setting('Account', [
        text('body', '', { style: 'margin-bottom: 8px;' }, `Logged in as ${me.name} [${me.id}]${me.factionTag ? `, faction ${me.factionTag}` : ''}.`),
        h('div', { c: 'root___ek5Sm' }, actionButton('cross', 'Log out', () => this.onLogout())),
      ]),
    );
  }

  private loginView(): HTMLElement {
    const status = text('body', 'message___V2QQb', {}, '');
    const key = textInput({ placeholder: 'API key (Public access)', maxLength: 16, onEnter: () => go(), cls: 'input___hkebW' });
    const consent = avatarCheckbox(false, () => {});
    const go = async () => {
      status.textContent = 'Checking your key…';
      try {
        await login(key.input.value, consent.input.checked);
        status.textContent = '';
        state.error = null;
        this.onLogin();
      } catch (e) {
        status.textContent = '';
        setError(e instanceof ApiError ? e.message : 'Login failed');
      }
    };
    return h(
      'div',
      { c: 'root___bdV8w tr-login' },
      setting('Torn Rooms', [
        text('body', '', {}, 'Extra chat rooms inside Torn chat. Create rooms, invite players or whole factions, join public rooms.'),
        text(
          'body',
          '',
          { style: 'margin-top: 8px;' },
          'Your Torn API key (Public access is enough) proves who you are. It is stored only in Tampermonkey and sent to the Torn Rooms server to check your identity every 6 hours; the server never stores it.',
        ),
        text(
          'body',
          '',
          { style: 'margin-top: 8px;' },
          'Stored on the server: your player ID, name and faction, your profile picture link only if you tick the box below, and the messages you post (the last 5,000 per room). Shared with no one outside the rooms you join.',
        ),
      ]),
      h('div', { c: 'row___gsxrG', style: 'margin-top: 10px;' }, key.root, tornBtn('Log in', go)),
      h('div', { c: 'row___gsxrG', style: 'margin-top: 8px;' }, consent.label),
      h('div', { c: 'row___gsxrG' }, text('link1', 'hrefLink___9O1GI', { href: KEY_URL, target: '_blank', rel: 'noopener' }, 'Create a Public key')),
      status,
    );
  }
}

function avatarCheckbox(checked: boolean, onChange: (v: boolean) => void): { label: HTMLElement; input: HTMLInputElement } {
  return checkbox('Show my Torn profile picture next to my messages', checked, onChange);
}

function withClick<T extends Element>(el: T, run: () => void): T {
  el.addEventListener('click', (e) => {
    e.stopPropagation();
    run();
  });
  return el;
}
