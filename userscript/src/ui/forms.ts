// Torn chat's own form components, rebuilt with our classes.
import { componentIcon, fill, h, icon, text, type Child } from '../dom';
import type { IconName } from '../generated/icons';
import type { COMPONENT_ICONS } from '../generated/room-icons';

/** oO: a titled setting row. */
export function setting(title: string, children: Child[], opts: { divider?: boolean; cls?: string } = {}): HTMLElement {
  return h('div', { c: `setting___nsZNm ${opts.divider === false ? '' : 'withDivider___kz3yv'} ${opts.cls ?? ''}` }, text('body', 'title___KbB7I', {}, `${title}:`), ...children);
}

/** Torn's checkbox with its label. */
export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void): { label: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', on: { change: (e: Event) => onChange((e.target as HTMLInputElement).checked) } });
  input.checked = checked;
  // A real <label>, so clicking the text ticks the box too.
  const root = h('label', { c: 'root___XpplE subtitle___u4sr8 root___D4fXT' }, input, label);
  return { label: root, input };
}

/** ok: Torn's text input, optionally with a trailing icon. */
export function textInput(opts: {
  value?: string;
  placeholder?: string;
  maxLength?: number;
  icon?: IconName;
  cls?: string;
  inputCls?: string;
  onInput?: (v: string) => void;
  onEnter?: (v: string) => void;
}): { root: HTMLElement; input: HTMLInputElement } {
  const input = h('input', {
    c: `input___yyCYj ${opts.icon ? 'withIcon___MvvN8' : ''} ${opts.inputCls ?? ''}`,
    placeholder: opts.placeholder,
    maxlength: opts.maxLength,
    value: opts.value ?? '',
    on: {
      input: (e: Event) => opts.onInput?.((e.target as HTMLInputElement).value),
      keydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') opts.onEnter?.((e.target as HTMLInputElement).value);
        e.stopPropagation(); // keep Torn's page shortcuts out of our inputs
      },
    },
  });
  const root = h('div', { c: `root___Npj4l ${opts.cls ?? ''}` }, text('placeholder', '', {}, input, opts.icon ? icon(opts.icon, 'icon___aCVAk') : null));
  return { root, input };
}

/** oz/oj: Torn's tab list (Access control) with icon + title tabs. */
export function tabList<T extends string>(
  options: { value: T; title: string; icon: keyof typeof COMPONENT_ICONS }[],
  selected: T,
  onSelect: (v: T) => void,
): HTMLElement {
  const root = h('div', { c: 'tabList___hrzal' });
  const draw = (current: T) => {
    fill(
      root,
      ...options.flatMap((o, i) => [
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            title: o.title,
            c: `root___FDeLd tabItem___YA_8M ${o.value === current ? 'selected___f9h6Z selected___qBZhh' : ''}`,
            on: {
              click: () => {
                onSelect(o.value);
                draw(o.value);
              },
            },
          },
          componentIcon(o.icon, 'icon___mLyRZ'),
          text('subtitle', 'tabTitle___hVWHw', {}, o.title),
        ),
        i < options.length - 1 ? h('div', { c: 'divider___yq6Xu' }) : null,
      ]),
    );
  };
  draw(selected);
  return root;
}

/** oN: a sub-view over the panel content, with Torn's back button. */
export function backView(backTitle: string, onBack: () => void, cls: string, children: Child[]): HTMLElement {
  return h(
    'div',
    { c: `root___Cnq5Q ${cls}` },
    h('button', { type: 'button', c: 'root___O8vU1 shadow___swjyt', on: { click: onBack } }, componentIcon('back', 'backIcon___xhiLR'), text('subtitle', '', {}, backTitle)),
    ...children,
  );
}

/** Torn's site-wide button. */
export function tornBtn(label: string, onClick: () => void, opts: { cls?: string; disabled?: boolean; submit?: boolean } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      type: opts.submit ? 'submit' : 'button',
      c: `torn-btn ${opts.cls ?? ''}`,
      disabled: opts.disabled,
      on: {
        click: (e: Event) => {
          if (!opts.submit) e.preventDefault();
          onClick();
        },
      },
    },
    label,
  );
}

/** oA: the settings-panel action button (icon | title). */
export function actionButton(iconName: IconName, title: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h(
    'button',
    { type: 'button', c: `root___Z_Afv ${cls}`, on: { click: onClick } },
    h('div', { c: 'iconWrapper___N1Bnd' }, icon(iconName, 'icon___eo4eO withTitle___U6QVy')),
    h('div', { c: 'divider___mnLeP' }),
    text('subtitle', 'title___ULAC9', {}, title),
  );
}

/** mv: the red warning strip shown instead of the composer. */
export function warning(message: string, ...extra: Child[]): HTMLElement {
  return text('error', 'root___PCyAT', {}, componentIcon('warning', 'icon___TMKXI'), ' ', h('span', { c: 'message___GOEQ9' }, message), ...extra);
}

/** mh: the neutral strip (Connecting…). */
export function info(message: string, ...extra: Child[]): HTMLElement {
  return text('body', 'root___XpFMX', {}, componentIcon('info', 'icon___S_26w'), ' ', h('span', { c: 'message___Zzf2J' }, message), ...extra);
}

/** Parses a player or faction id from an id or a pasted Torn profile / faction link. */
export function parseTornId(input: string): number | null {
  const s = input.trim();
  const m = /(?:XID=|[?&]ID=|\[)(\d+)\]?/i.exec(s) ?? /^(\d+)$/.exec(s);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}
