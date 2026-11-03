// Create / edit a room: Torn's room settings form (name, icon, description, access control).
import { LIMITS, type PostPolicy, type Visibility } from '../../../shared/protocol';
import { h, roomIcon, ROOM_ICON_NAMES, text } from '../dom';
import { state } from '../store';
import { backView, checkbox, setting, tabList, textInput, tornBtn } from './forms';

export interface RoomFormValues {
  name: string;
  description: string;
  icon: string;
  color: string;
  visibility: Visibility;
  postPolicy: PostPolicy;
  showFactionTags: boolean;
}

export function roomForm(opts: {
  backTitle: string;
  submitTitle: string;
  initial?: RoomFormValues;
  onBack: () => void;
  onSubmit: (v: RoomFormValues) => Promise<void>;
}): HTMLElement {
  const v: RoomFormValues = opts.initial ? { ...opts.initial } : { name: '', description: '', icon: '', color: '', visibility: 'private', postPolicy: 'everyone', showFactionTags: false };
  const host = h('div', { style: 'display: contents;' });

  const main = () => {
    const submit = tornBtn(opts.submitTitle, () => {}, { cls: 'actionButton___ucXZJ', submit: true });
    const error = text('error', '', { style: 'margin: 10px 10px 0; display: none;' });
    const valid = () => {
      submit.disabled = !v.name.trim();
    };
    const name = textInput({ value: v.name, maxLength: LIMITS.roomName, onInput: (x) => ((v.name = x), valid()) });
    const desc = textInput({ value: v.description, maxLength: LIMITS.description, onInput: (x) => (v.description = x) });
    const iconBtn = h(
      'button',
      { type: 'button', c: 'root___Z_Afv iconWrapper___N1Bnd iconButton___URo_b', on: { click: () => picker() } },
      h('div', { c: 'iconWrapper___N1Bnd' }, roomIcon(v.icon, 'icon___eo4eO')),
    );
    const accessOptions: { value: Visibility; title: string; icon: 'accessPrivate' | 'accessPublic' }[] = [{ value: 'private', title: 'Invite only', icon: 'accessPrivate' }];
    if (state.me?.superadmin) accessOptions.push({ value: 'public', title: 'Public', icon: 'accessPublic' });
    const form = h(
      'form',
      {
        on: {
          submit: async (e: Event) => {
            e.preventDefault();
            submit.disabled = true;
            error.style.display = 'none';
            try {
              await opts.onSubmit({ ...v, name: v.name.trim(), description: v.description.trim() });
            } catch (err) {
              error.textContent = (err as Error).message;
              error.style.display = '';
              submit.disabled = false;
            }
          },
        },
      },
      backView(opts.backTitle, opts.onBack, 'tr-scroll', [
        h(
          'div',
          { style: 'display: flex; flex-direction: row;' },
          setting('Room name', [name.root], { cls: 'roomNameSetting___S2obB' }),
          setting('Icon', [iconBtn]),
        ),
        setting('Room description', [h('div', { c: 'row___gZZ09' }, desc.root)]),
        setting('Color', [colorPicker(v.color, (c) => (v.color = c))]),
        setting('Access control', [tabList(accessOptions, v.visibility, (x) => (v.visibility = x))]),
        setting('Who can write', [
          tabList(
            [
              { value: 'everyone' as PostPolicy, title: 'Everyone', icon: 'accessPublic' as const },
              { value: 'admins' as PostPolicy, title: 'Admins only', icon: 'accessExclusive' as const },
            ],
            v.postPolicy,
            (x) => (v.postPolicy = x),
          ),
        ]),
        setting('Names', [checkbox('Show [faction tag] before names', v.showFactionTags, (x) => (v.showFactionTags = x)).label]),
        error,
        submit,
      ]),
    );
    valid();
    host.replaceChildren(form);
    name.input.focus();
  };

  // oS: the icon picker.
  const picker = () => {
    const grid = h('div', { c: 'collection___MXn9U' });
    const draw = (q: string) =>
      grid.replaceChildren(
        ...['', ...ROOM_ICON_NAMES]
          .filter((n) => !q || n.includes(q.toLowerCase()))
          .map((n) =>
            h('div', { role: 'presentation', title: n || 'default', on: { click: () => ((v.icon = n), main()) } }, roomIcon(n, '', n || 'default')),
          ),
      );
    const search = textInput({ placeholder: 'Search icons', icon: 'search', cls: 'input___dQlNS', onInput: draw });
    draw('');
    host.replaceChildren(backView('Back to settings', main, 'root___SvMxo', [search.root, grid]));
    search.input.focus();
  };

  main();
  return host;
}

// Torn-toned presets; '' keeps Torn's grey. The last swatch opens the system color picker.
const PRESETS = ['', '#b22222', '#c2571a', '#b8860b', '#2e7d32', '#00838f', '#1565c0', '#6a1b9a', '#ad1457'];

function colorPicker(initial: string, onChange: (c: string) => void): HTMLElement {
  let current = initial;
  const custom = h('input', {
    type: 'color',
    title: 'Custom color',
    value: initial && !PRESETS.includes(initial) ? initial : '#888888',
    on: { input: (e: Event) => pick((e.target as HTMLInputElement).value) },
  });
  const customSwatch = h('label', { c: 'tr-swatch tr-swatch-custom', title: 'Custom color' }, custom);
  const swatches = PRESETS.map((c) =>
    h('button', {
      type: 'button',
      title: c || 'Default',
      c: `tr-swatch ${c ? '' : 'tr-swatch-default'}`,
      style: c ? `--tr-room: ${c}` : undefined,
      on: { click: () => pick(c) },
    }),
  );
  // Only toggle classes: rebuilding would close the system color picker while it is open.
  const draw = () => {
    swatches.forEach((el, i) => el.classList.toggle('tr-swatch-on', PRESETS[i] === current));
    const isCustom = !!current && !PRESETS.includes(current);
    customSwatch.classList.toggle('tr-swatch-on', isCustom);
    if (isCustom) customSwatch.style.setProperty('--tr-room', current);
  };
  const pick = (c: string) => {
    current = c;
    onChange(c);
    draw();
  };
  draw();
  return h('div', { c: 'tr-swatches' }, ...swatches, customSwatch);
}
