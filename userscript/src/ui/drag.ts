// Drag to reorder, with Torn chat's thresholds: a mouse drag starts after
// 3px, a touch drag after holding 250ms. The element follows the pointer; on drop the nearest slot wins.

export interface Slot {
  key: string;
  center: number;
}

export interface SortableOptions {
  el: HTMLElement;
  key: string;
  /** Whether a pointerdown on this target may start a drag (headers yes, inputs and menus no). */
  canStart: (target: Element) => boolean;
  /** Slot centers (x) of every sortable item, this one included, read when the drag starts. */
  slots: () => Slot[];
  /** The element's resting transform, kept under the drag offset. */
  base: () => string;
  axis: 'x' | 'xy';
  onStart?: () => void;
  /** targetKey is null when dropped back on its own slot or cancelled. */
  onEnd: (targetKey: string | null) => void;
}

const MOUSE_DISTANCE = 3;
const TOUCH_DELAY = 250;
const TOUCH_TOLERANCE = 5;

export function sortable(o: SortableOptions): void {
  o.el.addEventListener('pointerdown', (down) => {
    if (down.button !== 0 || !o.canStart(down.target as Element)) return;
    const touch = down.pointerType === 'touch';
    const t0 = performance.now();
    let active = false;
    let slots: Slot[] = [];

    const detach = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    const finish = (target: string | null) => {
      detach();
      if (!active) return;
      o.el.classList.remove('tr-dragging');
      swallowNextClick(o.el);
      o.onEnd(target === o.key ? null : target);
    };
    const move = (e: PointerEvent) => {
      const dx = e.clientX - down.clientX;
      const dy = e.clientY - down.clientY;
      if (!active) {
        const dist = Math.hypot(dx, dy);
        const held = performance.now() - t0;
        if (touch) {
          if (held < TOUCH_DELAY) return dist > TOUCH_TOLERANCE ? detach() : undefined;
        } else if (dist < MOUSE_DISTANCE) return;
        active = true;
        slots = o.slots();
        o.el.classList.add('tr-dragging');
        o.onStart?.();
      }
      e.preventDefault();
      o.el.style.transform = `${o.base()} translate(${dx}px, ${o.axis === 'xy' ? dy : 0}px)`;
    };
    const up = (e: PointerEvent) => {
      if (!active) return detach();
      let best: string | null = null;
      let bestDist = Infinity;
      for (const s of slots) {
        const d = Math.abs(s.center - e.clientX);
        if (d < bestDist) {
          bestDist = d;
          best = s.key;
        }
      }
      finish(best);
    };
    const cancel = () => finish(null);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  });
}

/** The click that ends a drag must not also toggle the panel or open its menu. */
function swallowNextClick(el: HTMLElement): void {
  const stop = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
  };
  el.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => el.removeEventListener('click', stop, { capture: true }), 400);
}
