// ECO map: five rows (A-E) of 100 cells, coloured by average stored depth.

const VOLUMES = ['A', 'B', 'C', 'D', 'E'];

/**
 * @param {object} o.colorOf  cell colour for a code's record (default: by average depth)
 * @param {object} o.hasData  whether a record counts as non-empty (default: has openings)
 */
export function renderEcoMap(container, codes, { selected, onSelect, onHover, colorOf = (c) => depthColor(c.avgDepth), hasData = (c) => Boolean(c && c.openings) }) {
  container.innerHTML = '';
  for (const vol of VOLUMES) {
    const row = document.createElement('div');
    row.className = 'eco-row';
    const label = document.createElement('span');
    label.className = 'eco-row-label';
    label.textContent = vol;
    row.appendChild(label);
    for (let i = 0; i < 100; i++) {
      const code = vol + String(i).padStart(2, '0');
      const cell = document.createElement('div');
      cell.className = 'eco-cell';
      const c = codes[code];
      if (!hasData(c)) {
        cell.classList.add('empty');
      } else {
        cell.style.background = colorOf(c);
        if (selected === code) cell.classList.add('selected');
        cell.addEventListener('click', () => onSelect(code));
        cell.addEventListener('mouseenter', (e) => onHover(e, code, c));
        cell.addEventListener('mouseleave', (e) => onHover(e, null));
      }
      row.appendChild(cell);
    }
    container.appendChild(row);
  }
}

/** Sequential orange ramp for depth (0 = surface, 30+ = darkest). */
export function depthColor(depth) {
  if (!depth) return 'var(--surface-2)';
  if (depth < 10) return 'var(--depth-1)';
  if (depth < 18) return 'var(--depth-2)';
  if (depth < 26) return 'var(--depth-3)';
  return 'var(--depth-4)';
}

/** Sequential blue ramp for a share in [0, 1] (games in an ECO code / the busiest code). */
export function frequencyColor(share) {
  if (!share) return 'var(--surface-2)';
  if (share < 0.1) return 'var(--freq-1)';
  if (share < 0.3) return 'var(--freq-2)';
  if (share < 0.6) return 'var(--freq-3)';
  return 'var(--freq-4)';
}
