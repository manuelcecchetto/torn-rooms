// Tiny DOM helpers. Torn class names (name___hash) are prefixed with tr_ so they
// match our copy of Torn's chat CSS (generated/torn-chat.css), never Torn's live one.
import { ICONS, type IconName } from './generated/icons';
import { COMPONENT_ICONS, ROOM_ICONS } from './generated/room-icons';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts
    .filter(Boolean)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((c) => (c.includes('___') && !c.startsWith('tr_') ? 'tr_' + c : c))
    .join(' ');
}

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  c?: string;
  style?: string;
  on?: Record<string, (e: any) => void>;
  [attr: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'c') el.className = cx(v as string);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v as Record<string, (e: Event) => void>)) el.addEventListener(ev, fn);
    else if (k === 'style') el.setAttribute('style', v as string);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

/** replaceChildren that accepts the same children as h(), including null and arrays. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

export function append(el: Node, children: Child[]): void {
  for (const c of children.flat(Infinity as 1) as Child[]) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const NS = 'http://www.w3.org/2000/svg';
let gradientSeq = 0;

/** Torn's icon component: an SVG whose paths are filled by a CSS-coloured gradient. */
function svg(def: { viewBox: string; inner: string; width?: string | null; height?: string | null }, cls: string, label?: string): SVGSVGElement {
  const el = document.createElementNS(NS, 'svg');
  const id = `tr_icon_gradient${++gradientSeq}_default`;
  el.setAttribute('viewBox', def.viewBox);
  el.setAttribute('width', def.width ?? '24');
  el.setAttribute('height', def.height ?? '24');
  el.setAttribute('class', cx('root___mSyc0', cls));
  if (label) {
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', label);
    el.setAttribute('tabindex', '0');
  }
  const inner = def.inner.includes('__GID__')
    ? def.inner.replace(/__GID__/g, id)
    : `<defs><linearGradient id="${id}" x1="0.5" x2="0.5" y2="1" gradientUnits="objectBoundingBox"><stop id="start" offset="0"></stop><stop id="end" offset="1"></stop></linearGradient></defs><g fill="url(#${id})">${def.inner}</g>`;
  el.innerHTML = inner; // constant markup generated from Torn's own icons, never user content
  return el;
}

export const icon = (name: IconName, cls = '', label?: string) => svg(ICONS[name], cls, label);
export const componentIcon = (name: keyof typeof COMPONENT_ICONS, cls = '') => svg(COMPONENT_ICONS[name], cls);
export const roomIcon = (name: string, cls = '', label?: string) => svg(ROOM_ICONS[name] ?? ICONS.chats, cls, label);
export const ROOM_ICON_NAMES = Object.keys(ROOM_ICONS);

type Variant = 'headingH1' | 'subtitle' | 'body' | 'error' | 'success' | 'placeholder' | 'link1' | 'link2' | 'divider1' | 'divider2';
const VARIANT: Record<Variant, string> = {
  headingH1: 'headingH1___VK9XQ',
  subtitle: 'subtitle___u4sr8',
  body: 'body___HxuJg',
  error: 'error___jHa2z',
  success: 'success___QgAFZ',
  placeholder: 'placeholder___NCioo',
  link1: 'link1___jjWAf',
  link2: 'link2___CQita',
  divider1: 'divider1___XB_RF',
  divider2: 'divider2___nG653',
};
const TAG: Record<Variant, 'span' | 'p' | 'a'> = {
  headingH1: 'span', subtitle: 'span', body: 'p', error: 'p', success: 'p', placeholder: 'span', link1: 'a', link2: 'a', divider1: 'span', divider2: 'span',
};

/** Torn's Text component. */
export function text(variant: Variant, cls: string, props: Props, ...children: Child[]): HTMLElement {
  return h(TAG[variant], { ...props, c: `root___XpplE ${VARIANT[variant]} ${cls}` }, ...children);
}

/** Torn's unread counter badge (ln component). */
export function badge(cls: string, count: number): HTMLElement | null {
  if (!count) return null;
  return h('div', { c: cls }, text('headingH1', `root____FDYX ${count < 10 ? 'oneDigit___FJ3vn' : ''} ${count > 99 ? 'threeDigits___LxKm3' : ''}`, { style: 'color: white;' }, count > 99 ? '99+' : count));
}

// Torn shows Torn City Time (UTC).
const pad = (n: number) => String(n).padStart(2, '0');
export function tct(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
export function tctDay(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${String(d.getUTCFullYear()).slice(2)}`;
}
/** Relative time as moment's fromNow() with its default thresholds, which Torn's chat uses ("an hour ago" from 45 minutes). */
export function ago(ts: number, now = Date.now()): string {
  const ms = Math.abs(now - ts);
  const seconds = Math.round(ms / 1000);
  const minutes = Math.round(ms / 60_000);
  const hours = Math.round(ms / 3_600_000);
  const days = Math.round(ms / 86_400_000);
  const months = Math.round((ms / 86_400_000) * (4800 / 146097));
  const years = Math.round((ms / 86_400_000) * (400 / 146097));
  const unit = (n: number, one: string, many: string) => (n <= 1 ? one : `${n} ${many}`);
  const s =
    seconds < 45 ? 'a few seconds'
    : minutes < 45 ? unit(minutes, 'a minute', 'minutes')
    : hours < 22 ? unit(hours, 'an hour', 'hours')
    : days < 26 ? unit(days, 'a day', 'days')
    : months < 11 ? unit(months, 'a month', 'months')
    : unit(years, 'a year', 'years');
  return `${s} ago`;
}

/** Splits text into text nodes and https links, like Torn's chat. */
export function linkify(s: string): Child[] {
  const out: Child[] = [];
  let last = 0;
  for (const m of s.matchAll(/https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g)) {
    if (m.index! > last) out.push(s.slice(last, m.index));
    out.push(h('a', { href: m[0], target: '_blank', rel: 'noopener noreferrer' }, m[0]));
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
