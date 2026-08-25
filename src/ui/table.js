// =====================================================================
//  TOLYQ / UI — ТАБЛИЦА ВАРИАНТОВ
// ---------------------------------------------------------------------
//  График показывает форму компромисса, таблица — точные числа. Логисту
//  нужно и то и другое: сначала увидеть фронт, потом отсортировать по
//  цене и прочитать конкретные значения.
//
//  Таблица делит подсветку с графиком и картой: наведение на строку
//  подсвечивает тот же маршрут, что и наведение на точку.
// =====================================================================

import * as fmt from './format.js';

const COLUMNS = [
  { key: 'label',   title: 'Вариант',   num: false },
  { key: 'costKzt', title: 'Стоимость', num: true, fmt: v => fmt.kzt(v) },
  { key: 'hours',   title: 'Срок',      num: true, fmt: v => fmt.hoursShort(v) },
  { key: 'co2Kg',   title: 'CO₂',       num: true, fmt: v => fmt.co2(v) },
  { key: 'fillPct', title: 'Загрузка',  num: true, fmt: v => fmt.pct(v) },
];

export function createTable(root, { onHover } = {}) {
  let data = null;
  let sortKey = 'costKzt';
  let sortDir = 1;              // 1 — по возрастанию
  let hotId = null;

  return { update, setHot, clear: () => setHot(null) };

  function update(solution, request) {
    data = { solution, request };
    render();
  }

  function setHot(id) {
    hotId = id;
    for (const tr of root.querySelectorAll('tbody tr')) {
      tr.classList.toggle('is-hot', tr.dataset.id === hotId);
    }
  }

  function render() {
    if (!data) return;
    const { solution: sol } = data;
    const rows = [...sol.pareto, ...sol.dominated];

    if (!rows.length) {
      root.innerHTML = emptyHtml();
      return;
    }

    const sorted = rows.slice().sort((a, b) => {
      const A = a[sortKey], B = b[sortKey];
      if (typeof A === 'string') return A.localeCompare(B, 'ru') * sortDir;
      return (A - B) * sortDir;
    });

    const head = COLUMNS.map(c => {
      const active = c.key === sortKey;
      const aria = active ? ` aria-sort="${sortDir === 1 ? 'ascending' : 'descending'}"` : '';
      return `<th class="${c.num ? 'num' : ''}" data-key="${c.key}"${aria}
        tabindex="0" role="columnheader">${c.title}<span class="table__arrow">↑</span></th>`;
    }).join('');

    const body = sorted.map(r => {
      const kind = r.id === sol.recommended.id ? 'rec'
                 : r.id === sol.truckBaseline.id ? 'base'
                 : r.dominatedBy ? 'dim' : 'front';
      const tag = kind === 'rec'  ? '<span class="table__tag table__tag--rec">рекомендуем</span>'
                : kind === 'base' ? '<span class="table__tag table__tag--base">возят сегодня</span>'
                : !r.feasible     ? '<span class="table__tag table__tag--miss">не в срок</span>'
                : '';
      const cells = COLUMNS.map(c => c.key === 'label'
        ? `<td><span class="table__name"><i class="table__mark"></i>${esc(r.label)}${tag}</span></td>`
        : `<td class="num">${c.fmt(r[c.key])}</td>`).join('');

      return `<tr class="table__row table__row--${kind}${r.feasible ? '' : ' table__row--miss'}"
                  data-id="${esc(r.id)}">${cells}</tr>`;
    }).join('');

    root.innerHTML = `
      <div class="table-wrap">
        <table class="table">
          <thead><tr>${head}</tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;

    // сортировка по заголовку
    for (const th of root.querySelectorAll('th')) {
      const go = () => {
        const key = th.dataset.key;
        if (key === sortKey) sortDir = -sortDir;
        else { sortKey = key; sortDir = key === 'label' ? 1 : 1; }
        render();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }

    // строка ведёт себя как точка на графике
    for (const tr of root.querySelectorAll('tbody tr')) {
      const route = rows.find(r => r.id === tr.dataset.id);
      tr.addEventListener('pointerenter', () => { setHot(tr.dataset.id); onHover?.(route); });
      tr.addEventListener('pointerleave', () => { setHot(null); onHover?.(null); });
    }

    if (hotId) setHot(hotId);
  }
}

function emptyHtml() {
  return `<div class="empty">
    <span class="empty__ico">${ICON}</span>
    <p class="empty__title">Вариантов нет</p>
    <p class="empty__text">Между этими городами не нашлось ни одного пути.
       Выберите другой пункт назначения.</p>
  </div>`;
}

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`;

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
