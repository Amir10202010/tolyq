// =====================================================================
//  TOLYQ / UI — ФРОНТ ПАРЕТО
// ---------------------------------------------------------------------
//  По горизонтали срок, по вертикали деньги, размер точки — выбросы.
//  Три критерия читаются одновременно, поэтому и график один, а не три.
//
//  Оси начинаются от нуля осознанно: только так видно, что фура стоит
//  вчетверо дороже вагона, а не «немного правее по шкале».
//
//  SVG рисуется в честных экранных пикселях (viewBox = размер контейнера),
//  а не масштабируется. Иначе подписи на телефоне уезжают в 6 px.
// =====================================================================

import * as fmt from './format.js';

const M = { top: 18, right: 18, bottom: 36, left: 62 };
const R_MIN = 4.2, R_MAX = 13;

export function createPareto(root, { onHover } = {}) {
  const tip = document.getElementById('pareto-tip');
  if (tip && tip.parentElement !== root) root.appendChild(tip);

  let data = null;        // { solution, request }
  let hotId = null;
  let frame = null;
  let geom = null;        // положение точек после последней отрисовки

  const ro = new ResizeObserver(() => schedule());
  ro.observe(root);

  return { update, setHot, clear: () => setHot(null) };

  // ------------------------------------------------------------------

  /** Смена данных рисуется сразу: ждать кадра тут нечего. */
  function update(solution, request) {
    data = { solution, request };
    if (hotId && !findRoute(hotId)) hotId = null;
    render();
  }

  /** А вот поток событий от ResizeObserver склеиваем в один кадр. */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  }

  function setHot(id, { showTip = false } = {}) {
    hotId = id;
    if (!geom) return;
    for (const g of geom.nodes) {
      g.el.classList.toggle('is-hot', g.id === hotId);
      if (g.id === hotId) g.el.parentNode.appendChild(g.el);   // поднять над остальными
    }
    const hit = geom.nodes.find(g => g.id === hotId);
    if (hit && showTip) showTipFor(hit);
    else hideTip();
  }

  // ------------------------------------------------------------------

  function render() {
    if (!data) return;
    const w = root.clientWidth;
    if (!w) return;

    const { solution: sol, request: req } = data;

    if (!sol.pareto.length && !sol.dominated.length) {
      root.innerHTML = emptyHtml('Вариантов не нашлось',
        'Между этими городами нет ни одного пути. Выберите другой пункт назначения.');
      geom = null;
      return;
    }

    const h = Math.round(Math.min(480, Math.max(272, w * 0.80)));

    const points = [
      ...sol.dominated.map(r => ({ r, kind: 'dim' })),
      ...sol.pareto.map(r => ({
        r,
        kind: r.id === sol.recommended.id ? 'rec'
            : r.id === sol.truckBaseline.id ? 'base'
            : 'front',
      })),
    ];

    const plotW = w - M.left - M.right;
    const plotH = h - M.top - M.bottom;

    const maxH   = Math.max(...points.map(p => p.r.hours), req.deadlineH) * 1.06;
    const maxKzt = Math.max(...points.map(p => p.r.costKzt)) * 1.08;
    const co2s   = points.map(p => p.r.co2Kg);
    const co2Lo  = Math.min(...co2s), co2Hi = Math.max(...co2s);

    const x = v => M.left + (v / maxH) * plotW;
    const y = v => M.top + plotH - (v / maxKzt) * plotH;
    const rad = v => co2Hi - co2Lo < 1e-6 ? 6
      : R_MIN + (R_MAX - R_MIN) * Math.sqrt((v - co2Lo) / (co2Hi - co2Lo));

    const parts = [];

    // --- зона за сроком: туда нельзя, и это видно ----------------------
    const dx = x(req.deadlineH);
    if (dx < M.left + plotW) {
      parts.push(`<rect class="deadline-zone" x="${dx.toFixed(1)}" y="${M.top}"
        width="${(M.left + plotW - dx).toFixed(1)}" height="${plotH}"/>`);
    }

    // --- сетка и оси ---------------------------------------------------
    for (const t of niceTicks(maxKzt, 5)) {
      const yy = y(t);
      parts.push(`<line class="ax-tick" x1="${M.left}" y1="${yy.toFixed(1)}" x2="${M.left + plotW}" y2="${yy.toFixed(1)}"/>`);
      parts.push(`<text class="ax-text" x="${M.left - 8}" y="${(yy + 3.2).toFixed(1)}" text-anchor="end">${t === 0 ? '0' : fmt.kzt(t, { short: true, symbol: false })}</text>`);
    }
    for (const t of niceTicks(maxH, 5)) {
      const xx = x(t);
      parts.push(`<line class="ax-tick" x1="${xx.toFixed(1)}" y1="${M.top}" x2="${xx.toFixed(1)}" y2="${M.top + plotH}"/>`);
      parts.push(`<text class="ax-text" x="${xx.toFixed(1)}" y="${M.top + plotH + 14}" text-anchor="middle">${Math.round(t)}</text>`);
    }
    parts.push(`<line class="ax-line" x1="${M.left}" y1="${M.top + plotH}" x2="${M.left + plotW}" y2="${M.top + plotH}"/>`);
    parts.push(`<line class="ax-line" x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + plotH}"/>`);
    parts.push(`<text class="ax-title" x="${M.left}" y="${M.top - 6}">Стоимость, ₸</text>`);
    parts.push(`<text class="ax-title" x="${M.left + plotW}" y="${h - 6}" text-anchor="end">Срок доставки, часов</text>`);

    // --- линия срока ---------------------------------------------------
    if (dx < M.left + plotW) {
      parts.push(`<line class="deadline-line" x1="${dx.toFixed(1)}" y1="${M.top}" x2="${dx.toFixed(1)}" y2="${M.top + plotH}"/>`);
      const anchor = dx > M.left + plotW - 70 ? 'end' : 'start';
      const tx = anchor === 'end' ? dx - 5 : dx + 5;
      parts.push(`<text class="deadline-text" x="${tx.toFixed(1)}" y="${M.top + 10}" text-anchor="${anchor}">срок ${Math.round(req.deadlineH)} ч</text>`);
    }

    // --- ступенчатая линия фронта --------------------------------------
    const front = sol.pareto.slice().sort((a, b) => a.hours - b.hours);
    if (front.length > 1) {
      let d = `M ${x(front[0].hours).toFixed(1)} ${y(front[0].costKzt).toFixed(1)}`;
      for (let i = 1; i < front.length; i++) {
        d += ` L ${x(front[i].hours).toFixed(1)} ${y(front[i - 1].costKzt).toFixed(1)}`;
        d += ` L ${x(front[i].hours).toFixed(1)} ${y(front[i].costKzt).toFixed(1)}`;
      }
      parts.push(`<path class="front-line" d="${d}"/>`);
    }

    // --- точки ----------------------------------------------------------
    const nodes = [];
    for (const p of points) {
      const px = x(p.r.hours), py = y(p.r.costKzt), pr = rad(p.r.co2Kg);
      const cls = ['pt', `pt--${p.kind}`];
      if (!p.r.feasible) cls.push('pt--infeasible');

      let mark;
      if (p.r.feasible) {
        mark = `<circle class="pt__dot" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${pr.toFixed(1)}"/>`;
      } else {
        // не влезает в срок — крестик вместо точки
        const s = (pr * 0.95).toFixed(1);
        mark = `<g class="pt__cross-wrap">
          <line class="pt__cross" x1="${(px - s).toFixed(1)}" y1="${(py - s).toFixed(1)}" x2="${(px - -s).toFixed(1)}" y2="${(py - -s).toFixed(1)}"/>
          <line class="pt__cross" x1="${(px - s).toFixed(1)}" y1="${(py - -s).toFixed(1)}" x2="${(px - -s).toFixed(1)}" y2="${(py - s).toFixed(1)}"/>
        </g>`;
      }

      parts.push(`<g class="${cls.join(' ')}" data-id="${p.r.id}" role="img"
        aria-label="${esc(p.r.label)}: ${fmt.kzt(p.r.costKzt)}, ${fmt.hoursShort(p.r.hours)}, ${fmt.co2(p.r.co2Kg)}">
        <circle class="pt__halo" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(pr + 5).toFixed(1)}"/>
        ${mark}
        <circle class="pt__hit" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${Math.max(13, pr + 8).toFixed(1)}" fill="transparent"/>
      </g>`);

      nodes.push({ id: p.r.id, route: p.r, kind: p.kind, px, py, pr });
    }

    // --- подписи двух опорных точек ------------------------------------
    for (const key of ['base', 'rec']) {
      const n = nodes.find(v => v.kind === key);
      if (!n) continue;
      // Подписи набраны капителью и потому длинные не влезают: у опорной
      // точки оставлено два слова, полная формулировка есть в подсказке.
      const label = key === 'rec' ? 'рекомендуем' : 'везут сегодня';
      const wantsLeft = n.px > M.left + plotW * 0.42;
      const tx = wantsLeft ? n.px - n.pr - 7 : n.px + n.pr + 7;
      const ty = key === 'rec' ? n.py - n.pr - 7 : n.py + n.pr + 13;
      parts.push(`<text class="pt__label pt__label--${key}" x="${tx.toFixed(1)}" y="${ty.toFixed(1)}"
        text-anchor="${wantsLeft ? 'end' : 'start'}">${label}</text>`);
    }

    root.innerHTML =
      `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="group"
            aria-label="Фронт Парето: стоимость против срока, размер точки — выбросы CO₂">
         ${parts.join('')}
       </svg>` + legendHtml();
    if (tip) root.appendChild(tip);

    // --- события --------------------------------------------------------
    const svg = root.querySelector('svg');
    for (const n of nodes) {
      n.el = svg.querySelector(`.pt[data-id="${cssEsc(n.id)}"]`);
      if (!n.el) continue;
      n.el.addEventListener('pointerenter', () => hover(n));
      n.el.addEventListener('pointerdown', () => hover(n));
      n.el.addEventListener('pointerleave', e => {
        if (e.pointerType === 'touch') return;
        leave();
      });
    }
    svg.addEventListener('pointerleave', leave);

    geom = { nodes, w, h };
    if (hotId) setHot(hotId);
  }

  function hover(n) {
    hotId = n.id;
    for (const g of geom?.nodes || []) g.el?.classList.toggle('is-hot', g.id === hotId);
    n.el.parentNode.appendChild(n.el);
    showTipFor(n);
    onHover?.(n.route);
  }

  function leave() {
    hotId = null;
    for (const g of geom?.nodes || []) g.el?.classList.remove('is-hot');
    hideTip();
    onHover?.(null);
  }

  // ------------------------------------------------------------------

  function showTipFor(n) {
    if (!tip || !geom) return;
    const r = n.route;
    const sol = data.solution;

    const rows = [
      ['стоимость', fmt.kzt(r.costKzt)],
      ['срок', fmt.hoursShort(r.hours)],
      ['выбросы', fmt.co2(r.co2Kg)],
      ['загрузка', fmt.pct(r.fillPct)],
    ];

    const legs = (r.legs || []).map(l => `
      <div class="tip__leg is-${l.mode}"><i></i><span>${nameOf(l.from)} — ${nameOf(l.to)},
      ${fmt.km(l.km)}, ${fmt.hoursShort(l.hours)}${l.transshipment ? ', с перегрузкой' : ''}</span></div>`).join('');

    let flag = '';
    // Кирпичный цвет — только у настоящего провала, то есть у срыва срока.
    // «Как везут сегодня» — не ошибка, а точка отсчёта, и метится она
    // цветом автодороги: тем же, что и сама точка на графике.
    if (!r.feasible) flag = `<p class="tip__flag tip__flag--bad">не укладывается в срок</p>`;
    else if (r.id === sol.recommended.id) flag = `<p class="tip__flag tip__flag--go">рекомендуем</p>`;
    else if (r.id === sol.truckBaseline.id) flag = `<p class="tip__flag tip__flag--base">как везут сегодня</p>`;
    else if (r.dominatedBy) {
      const by = findRoute(r.dominatedBy);
      flag = `<p class="tip__flag tip__flag--dim">хуже, чем «${esc(by ? by.label : r.dominatedBy)}», сразу по всем трём</p>`;
    }

    tip.innerHTML =
      `<p class="tip__title">${esc(r.label)}</p>
       <div class="tip__rows">${rows.map(([k, v]) =>
         `<div class="tip__row"><span>${k}</span><span>${v}</span></div>`).join('')}</div>
       <div class="tip__legs">${legs}</div>
       ${r.note ? `<p class="tip__note">${esc(r.note)}</p>` : ''}
       ${flag}`;
    tip.hidden = false;

    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = n.px + n.pr + 12;
    let top  = n.py - th / 2;
    if (left + tw > geom.w - 4) left = n.px - n.pr - 12 - tw;
    left = Math.max(4, Math.min(left, geom.w - tw - 4));
    top  = Math.max(4, Math.min(top, geom.h - th - 4));
    tip.style.left = left + 'px';
    tip.style.top  = top + 'px';
  }

  function hideTip() { if (tip) tip.hidden = true; }

  function findRoute(id) {
    if (!data) return null;
    return [...data.solution.pareto, ...data.solution.dominated].find(r => r.id === id) || null;
  }
}

// ---------------------------------------------------------------------

/**
 * Легенда написана словами грузоотправителя, а не теории Парето:
 * «неулучшаемый» и «отброшен» — термины перебора, человеку они говорят
 * ровно ничего. Ключ к размеру точки стоит здесь же — раньше он жил в
 * двадцатисловной сноске под графиком, которую никто не читал.
 */
function legendHtml() {
  return `<div class="legend">
    <span class="legend__item"><i class="legend__dot legend__dot--rec"></i>наш выбор</span>
    <span class="legend__item"><i class="legend__dot legend__dot--front"></i>тоже хорошие</span>
    <span class="legend__item"><i class="legend__dot legend__dot--base"></i>так возят сейчас</span>
    <span class="legend__item"><i class="legend__dot legend__dot--dim"></i>хуже по всему</span>
    <span class="legend__item"><i class="legend__cross"></i>не успевает</span>
    <span class="legend__item"><i class="legend__size"></i>размер — выбросы</span>
  </div>`;
}


/** Пустое состояние графика: не белое пятно, а что делать дальше. */
function emptyHtml(title, text) {
  return `<div class="empty">
    <span class="empty__ico"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M3 17V7m0 10 6-3 6 3 6-3V4l-6 3-6-3-6 3"/></svg></span>
    <p class="empty__title">${title}</p>
    <p class="empty__text">${text}</p>
  </div>`;
}

/** Круглые деления: 0, 100 тыс, 200 тыс… а не 0, 87 435, 174 870. */
function niceTicks(max, count) {
  if (!isFinite(max) || max <= 0) return [0];
  const raw = max / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out = [];
  for (let v = 0; v <= max + step * 1e-6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const NAMES = new Map();
export function registerNames(nodes) { for (const n of nodes) NAMES.set(n.id, n.name); }
const nameOf = id => NAMES.get(id) || id;

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cssEsc = s => String(s).replace(/["\\]/g, '\\$&');
