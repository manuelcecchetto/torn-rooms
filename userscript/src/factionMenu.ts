// Adds "Open faction" to the title menu of Torn's own faction chat, as a private chat's menu has
// "View profile". Torn draws that menu, so the item copies one of its options to keep Torn's live
// class names and colours, and Torn's link markup (an <a> around the option button).
import { ICONS } from './generated/icons';

const MARK = 'data-tr-open-faction';

function addItem(): void {
  const menu = document.getElementById('faction')?.querySelector('[class*="optionsContainer___"]');
  if (!menu || menu.querySelector(`[${MARK}]`)) return;
  const options = menu.querySelectorAll(':scope > button');
  const model = options[options.length - 1];
  const svg = model?.querySelector('svg');
  const title = model?.querySelector('span');
  if (!model || !svg || !title) return;

  const button = model.cloneNode(false) as HTMLButtonElement;
  const glyph = svg.cloneNode(false) as SVGSVGElement;
  const def = ICONS.faction;
  const id = 'tr_open_faction_gradient';
  glyph.removeAttribute('id');
  glyph.setAttribute('viewBox', def.viewBox);
  glyph.setAttribute('class', [...svg.classList].filter((c) => !c.startsWith('toggled___')).join(' '));
  glyph.innerHTML = def.inner.replace(/__GID__/g, id); // constant markup from Torn's own icon
  const label = title.cloneNode(false) as HTMLSpanElement;
  label.textContent = 'Open faction';
  button.append(glyph, label);

  const link = document.createElement('a');
  link.setAttribute(MARK, '');
  link.href = '/factions.php?step=your';
  link.style.cssText = 'display: flex; text-decoration: none;';
  // Torn's options stop the click there, so it never reaches the header (which minimizes the panel).
  link.addEventListener('click', (e) => e.stopPropagation());
  link.append(button);
  menu.prepend(link);
}

export function watchFactionMenu(root: Element): void {
  addItem();
  new MutationObserver(addItem).observe(root, { childList: true, subtree: true });
}
