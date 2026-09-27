// ECO map: five rows (A-E) of 100 cells, coloured by average stored depth.

const VOLUMES = ['A', 'B', 'C', 'D', 'E'];

export function renderEcoMap(container, codes, { selected, onSelect, onHover }) {
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
      if (!c || !c.openings) {
        cell.classList.add('empty');
      } else {
        cell.style.background = depthColor(c.avgDepth);
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
