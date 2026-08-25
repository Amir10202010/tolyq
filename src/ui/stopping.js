// =====================================================================
//  TOLYQ / UI — ПОРОГОВАЯ КРИВАЯ ОПТИМАЛЬНОЙ ОСТАНОВКИ
// ---------------------------------------------------------------------
//  По горизонтали часы, по вертикали тоннаж. Кривая порога убывает: пока
//  времени много, отправляться имеет смысл только с полным вагоном; чем
//  ближе срок, тем ниже планка.
//
//  Правило читается с картинки без формул: точка ниже кривой — ждём,
//  пересекла — отправляем. Ради этого область под кривой и над ней
//  подписаны прямо на поле, а не в легенде сбоку.
//
//  Такт приходит из app.js, тот же самый, что и у сборки вагона. Точка
//  здесь и полоса там обязаны двигаться одними часами.
// =====================================================================

import * as fmt from './format.js';

const M = { top: 16, right: 16, bottom: 30, left: 38 };

export function createStopping(root, {} = {}) {
  let ctx = null;
  let dom = null;
  let frame = null;

  const ro = new ResizeObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; if (ctx) build(); });
  });
  ro.observe(root);

  return { update, tick, reset: () => tick({ h: 0 }) };

  // ------------------------------------------------------------------

  function update(next) {
    ctx = next;
    build();
  }

  function build() {
    if (!ctx) return;
    const w = root.clientWidth;
    if (!w) return;

    const { solution: sol, demo } = ctx;
    const st = sol.stopping;
    const cap = demo.capacityTons;
    const H = st.horizonH;

    const h = Math.round(Math.min(300, Math.max(196, w * 0.58)));
    const plotW = w - M.left - M.right;
    const plotH = h - M.top - M.bottom;

    const X = t => M.left + (t / H) * plotW;
    const Y = v => M.top + plotH - (v / cap) * plotH;

    // --- кривая порога ---------------------------------------------------
    const curve = st.thresholdByHour.map((v, t) => `${X(t).toFixed(1)},${Y(v).toFixed(1)}`);
    const areaWait = `M ${X(0).toFixed(1)},${Y(0).toFixed(1)} L ` + curve.join(' L ') +
                     ` L ${X(H).toFixed(1)},${Y(0).toFixed(1)} Z`;
    const areaGo   = `M ${X(0).toFixed(1)},${Y(cap).toFixed(1)} L ` + curve.join(' L ') +
                     ` L ${X(H).toFixed(1)},${Y(cap).toFixed(1)} Z`;

    // --- сетка -------------------------------------------------------------
    const grid = [];
    for (let t = 0; t <= H; t += 6) {
      grid.push(`<line class="ax-tick" x1="${X(t).toFixed(1)}" y1="${M.top}" x2="${X(t).toFixed(1)}" y2="${M.top + plotH}"/>
        <text class="ax-text" x="${X(t).toFixed(1)}" y="${M.top + plotH + 13}" text-anchor="middle">${t}</text>`);
    }
    for (let v = 0; v <= cap; v += cap / 4) {
      grid.push(`<line class="ax-tick" x1="${M.left}" y1="${Y(v).toFixed(1)}" x2="${M.left + plotW}" y2="${Y(v).toFixed(1)}"/>
        <text class="ax-text" x="${M.left - 6}" y="${(Y(v) + 3.2).toFixed(1)}" text-anchor="end">${Math.round(v)}</text>`);
    }

    const dx = X(st.dispatchAtH);

    root.innerHTML = `
      <div class="stop">
        <div class="stats stats--two">
          <div class="stat stat--good">
            <span class="stat__label">Соберём вагон в срок</span>
            <span class="stat__value">${fmt.pct(Math.round(st.probability * 100))}</span>
          </div>
          <div class="stat">
            <span class="stat__label">Отправлять на часе</span>
            <span class="stat__value">${fmt.hoursShort(st.dispatchAtH)}</span>
          </div>
        </div>

        <div class="chart">
          <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
               aria-label="Пороговая кривая: ждать, пока накопленный тоннаж ниже порога">
            <path class="thr-area-wait" d="${areaWait}"/>
            <path class="thr-area-go" d="${areaGo}"/>
            ${grid.join('')}

            <line class="thr-dispatch" x1="${dx.toFixed(1)}" y1="${M.top}" x2="${dx.toFixed(1)}" y2="${M.top + plotH}"/>
            <polyline class="thr-curve" points="${curve.join(' ')}"/>

            <text class="thr-zone-text thr-zone-text--go" x="${(M.left + 10).toFixed(1)}" y="${(M.top + 14).toFixed(1)}">отправляем</text>
            <text class="thr-zone-text thr-zone-text--wait" x="${(M.left + 10).toFixed(1)}" y="${(M.top + plotH - 8).toFixed(1)}">ждём</text>

            <path class="thr-acc" data-role="acc" d=""/>
            <circle class="thr-now" data-role="now" cx="${X(0).toFixed(1)}" cy="${Y(0).toFixed(1)}" r="4.6"/>

            <line class="ax-line" x1="${M.left}" y1="${M.top + plotH}" x2="${M.left + plotW}" y2="${M.top + plotH}"/>
            <line class="ax-line" x1="${M.left}" y1="${M.top}" x2="${M.left}" y2="${M.top + plotH}"/>
            <text class="ax-title" x="${M.left}" y="${M.top - 5}">тонн в вагоне</text>
            <text class="ax-title" x="${(M.left + plotW).toFixed(1)}" y="${h - 4}" text-anchor="end">часов ожидания</text>
          </svg>
        </div>

        <p class="stop__hint">Пока точка <b>ниже жёлтой кривой</b> — выгоднее подождать попутный груз. Как только она её <b>пересекла</b> — отправляем вагон.</p>
      </div>`;

    dom = {
      acc: root.querySelector('[data-role="acc"]'),
      now: root.querySelector('[data-role="now"]'),
      X, Y, H, cap,
    };
    tick({ h: 0 });
  }

  // ------------------------------------------------------------------

  function tick(clock) {
    if (!ctx || !dom) return;
    const { demo } = ctx;
    const h = Math.min(clock.h, dom.H);
    const state = demo.at(h);

    // ступенчатая линия накопления: груз прибывает скачками, а не течёт
    let d = `M ${dom.X(0).toFixed(1)} ${dom.Y(0).toFixed(1)}`;
    let acc = 0;
    for (const a of state.arrived) {
      if (!a.accepted) continue;
      d += ` L ${dom.X(a.atH).toFixed(1)} ${dom.Y(acc).toFixed(1)}`;
      acc += a.tons;
      d += ` L ${dom.X(a.atH).toFixed(1)} ${dom.Y(acc).toFixed(1)}`;
    }
    d += ` L ${dom.X(h).toFixed(1)} ${dom.Y(acc).toFixed(1)}`;
    dom.acc.setAttribute('d', d);

    dom.now.setAttribute('cx', dom.X(h).toFixed(1));
    dom.now.setAttribute('cy', dom.Y(acc).toFixed(1));
    dom.now.classList.toggle('thr-now--fired', state.departed);
  }
}
