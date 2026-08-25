// =====================================================================
//  TOLYQ / UI — СВОДКА ЗА ТРИДЦАТЬ ДНЕЙ
// ---------------------------------------------------------------------
//  Одна заявка — история. Тридцать дней коридора — уже эффект. Четыре
//  крупных числа и столбики по дням: сколько фур не поехало.
//
//  Выходные видны провалами без единой подписи — это и есть проверка,
//  что данные похожи на настоящий грузопоток, а не на ровный шум.
// =====================================================================

import * as fmt from './format.js';

const M = { top: 14, right: 4, bottom: 20, left: 30 };

export function createSummary(root) {
  let month = null;
  let frame = null;

  const ro = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; if (month) render(); });
  });
  ro.observe(root);

  return { update };

  function update(next) {
    month = next;
    render();
  }

  function render() {
    const w = root.clientWidth;
    if (!w || !month) return;

    const days = month.dailyTrucksAvoided || [];
    const h = Math.round(Math.min(190, Math.max(120, w * 0.16)));
    const plotW = w - M.left - M.right;
    const plotH = h - M.top - M.bottom;
    const max = Math.max(1, ...days);
    const peak = max;

    const step = plotW / Math.max(1, days.length);
    const barW = Math.max(3, step - 3);

    const bars = days.map((v, i) => {
      const bh = (v / max) * plotH;
      const x = M.left + i * step + (step - barW) / 2;
      const y = M.top + plotH - bh;
      return `<rect class="bar-day${v >= peak ? ' bar-day--peak' : ''}"
        x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.8, bh).toFixed(1)}">
        <title>День ${i + 1}: ${fmt.withPlural(v, 'фура', 'фуры', 'фур')} не поехали</title></rect>`;
    }).join('');

    const yTicks = [0, Math.round(max / 2), max].map(v => {
      const y = M.top + plotH - (v / max) * plotH;
      return `<text class="ax-text" x="${M.left - 6}" y="${(y + 3.2).toFixed(1)}" text-anchor="end">${v}</text>
        <line class="ax-tick" x1="${M.left}" y1="${y.toFixed(1)}" x2="${M.left + plotW}" y2="${y.toFixed(1)}"/>`;
    }).join('');

    root.innerHTML = `
      <div class="month">
        <div class="month__figures">
          <div class="figure">
            <span class="figure__label">Отправок</span>
            <span class="figure__value">${fmt.num(month.shipments)}</span>
          </div>
          <div class="figure figure--stop">
            <span class="figure__label">Фур не поехало</span>
            <span class="figure__value">${fmt.num(month.trucksAvoided)}</span>
          </div>
          <div class="figure figure--go">
            <span class="figure__label">CO₂ не сожжено</span>
            <span class="figure__value">${fmt.co2(month.co2SavedKg)}</span>
          </div>
          <div class="figure figure--go">
            <span class="figure__label">Сэкономлено</span>
            <span class="figure__value">${fmt.kzt(month.kztSaved, { short: true })}</span>
          </div>
        </div>

        <div class="chart chart--month">
          <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="Фуры, не поехавшие по дням месяца">
            ${yTicks}
            ${bars}
            <line class="bar-base" x1="${M.left}" y1="${M.top + plotH}" x2="${M.left + plotW}" y2="${M.top + plotH}"/>
            <text class="ax-title" x="${M.left}" y="${M.top - 4}">фур не поехало, по дням</text>
            <text class="ax-text" x="${M.left}" y="${h - 5}">1</text>
            <text class="ax-text" x="${(M.left + plotW).toFixed(1)}" y="${h - 5}" text-anchor="end">${days.length}</text>
          </svg>
        </div>
      </div>`;
  }
}
