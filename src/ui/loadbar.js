// =====================================================================
//  TOLYQ / UI — СБОРКА ВАГОНА
// ---------------------------------------------------------------------
//  Кульминация демонстрации. Полоса загрузки нарисована силуэтом вагона,
//  а не абстрактным прогресс-баром: зритель должен видеть, во что именно
//  складывается груз.
//
//  Статика строится ОДИН раз при монтировании, дальше каждый кадр меняет
//  только ширину обрезки и несколько подписей. Пересобирать SVG строкой
//  шестьдесят раз в секунду — верный способ получить рывки на проекторе.
//
//  Свои часы модуль не заводит: такт приходит снаружи, из app.js. Иначе
//  полоса и пороговая кривая разъедутся, а именно их одновременность и
//  есть весь смысл сцены.
// =====================================================================

import * as fmt from './format.js';

const SHIP_COLORS = ['--ship-1', '--ship-2', '--ship-3', '--ship-4', '--ship-5', '--ship-6'];
const EASE = 0.14;               // сглаживание налива, доля за кадр

export function createLoadbar(root, { controls }) {
  let ctx = null;                // { request, solution, demo }
  let dom = null;
  let shownTons = 0;
  let shownCo2 = 0;
  let seenKeys = new Set();
  let departed = false;
  let lastWidth = 0;
  let lastClock = { h: 0, running: false, finished: false };

  // Ширина вагона меняется при повороте телефона — пересобираем силуэт
  // и проигрываем сцену заново до текущего часа.
  const ro = new ResizeObserver(() => {
    const w = root.clientWidth;
    if (!ctx || !w || Math.abs(w - lastWidth) < 2) return;
    lastWidth = w;
    drawWagon(ctx.demo.capacityTons);
    replay();
  });
  ro.observe(root);

  return { update, tick, reset };

  // ------------------------------------------------------------------

  function update(next) {
    ctx = next;
    build();
  }

  function reset() {
    shownTons = 0;
    shownCo2 = 0;
    seenKeys = new Set();
    departed = false;
    if (dom) {
      dom.feed.innerHTML = '';
      dom.segments.innerHTML = '';
      dom.done.hidden = true;
      dom.wagon.classList.remove('is-departed');
    }
    tick({ h: 0, running: false, finished: false });
  }

  /** Перерисовали силуэт — восстанавливаем груз без повторных влётов. */
  function replay() {
    if (!dom) return;
    dom.segments.innerHTML = '';
    const state = ctx.demo.at(lastClock.h);
    for (const a of state.accepted) addSegment(a);
    tick(lastClock);
  }

  // ------------------------------------------------------------------

  function build() {
    const { solution: sol, demo } = ctx;
    const cap = demo.capacityTons;

    root.innerHTML = `
      <div class="load">
        <div class="runbar">
          <button class="btn btn--primary" type="button" data-act="run">Запустить</button>
          <button class="btn btn--ghost" type="button" data-act="reset">Сбросить</button>
          <span class="runbar__clock" data-role="clock"></span>
        </div>

        <div class="wagon" data-role="wagon"></div>

        <div class="stats">
          <div class="stat stat--warn">
            <span class="stat__label">Накоплено в вагоне</span>
            <span class="stat__value" data-role="c-tons">0 т</span>
          </div>
          <div class="stat stat--bad">
            <span class="stat__label">Фур не поехало</span>
            <span class="stat__value" data-role="c-trucks">0</span>
          </div>
          <div class="stat stat--good">
            <span class="stat__label">CO2 не сожжено</span>
            <span class="stat__value" data-role="c-co2">0 кг</span>
          </div>
        </div>

        <p class="done" data-role="done" hidden></p>
        <div class="feed" data-role="feed"></div>
      </div>`;

    const q = r => root.querySelector(`[data-role="${r}"]`);
    dom = {
      wagon: q('wagon'), feed: q('feed'), clock: q('clock'), done: q('done'),
      cTons: q('c-tons'), cTrucks: q('c-trucks'), cCo2: q('c-co2'),
      run: root.querySelector('[data-act="run"]'),
    };

    for (const b of root.querySelectorAll('.btn')) {
      b.addEventListener('click', () => {
        if (b.dataset.act === 'run') controls.toggle();
        else controls.reset();
      });
    }

    lastWidth = root.clientWidth;
    drawWagon(cap);
    reset();
  }

  /** Силуэт вагона строится один раз; дальше двигается только обрезка. */
  function drawWagon(cap) {
    const w = Math.max(260, dom.wagon.clientWidth || root.clientWidth || 480);
    const PADX = 10, BODY_Y = 24, BODY_H = 60, ROOF = 8;
    const bx = PADX + 14, bw = w - PADX * 2 - 28;

    const R = 5;                       // скругление кузова
    const BOT = BODY_Y + BODY_H;       // низ кузова
    const AXLE = BOT + 11;             // ось колёсных пар
    const SCALE_Y = AXLE + 15;         // шкала тоннажа — ПОД колёсами,
    const h = SCALE_Y + 18;            // иначе цифры лезут на тележки

    const ticks = [];
    for (let t = 0; t <= cap; t += cap / 4) {
      const x = bx + (t / cap) * bw;
      ticks.push(`<line class="wagon-tick" x1="${x.toFixed(1)}" y1="${SCALE_Y - 5}" x2="${x.toFixed(1)}" y2="${SCALE_Y}"/>
        <text class="wagon-tick-text" x="${x.toFixed(1)}" y="${SCALE_Y + 11}" text-anchor="${t === 0 ? 'start' : t >= cap ? 'end' : 'middle'}">${Math.round(t)}</text>`);
    }

    dom.wagon.innerHTML = `
      <svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img"
           aria-label="Загрузка вагона, вместимость ${cap} тонн">
        <defs>
          <clipPath id="tolyq-fill"><rect data-role="clip" x="${bx}" y="${BODY_Y}" width="0" height="${BODY_H}"/></clipPath>
          <clipPath id="tolyq-body"><rect x="${bx}" y="${BODY_Y}" width="${bw}" height="${BODY_H}" rx="${R}"/></clipPath>
        </defs>

        <!-- тележки: рисуем первыми, кузов их перекроет -->
        ${[bx + bw * 0.17, bx + bw * 0.29, bx + bw * 0.71, bx + bw * 0.83]
          .map(cx => `<circle class="wagon-wheel" cx="${cx.toFixed(1)}" cy="${AXLE}" r="6"/>`).join('')}
        <line class="wagon-frame" x1="${(bx + bw * 0.17).toFixed(1)}" y1="${AXLE}" x2="${(bx + bw * 0.29).toFixed(1)}" y2="${AXLE}"/>
        <line class="wagon-frame" x1="${(bx + bw * 0.71).toFixed(1)}" y1="${AXLE}" x2="${(bx + bw * 0.83).toFixed(1)}" y2="${AXLE}"/>

        <!-- крыша с небольшим свесом -->
        <path class="wagon-frame" d="M ${bx - 7} ${BODY_Y + 1} L ${bx + 5} ${BODY_Y - ROOF} L ${bx + bw - 5} ${BODY_Y - ROOF} L ${bx + bw + 7} ${BODY_Y + 1}"/>

        <!-- кузов и груз внутри него -->
        <rect class="wagon-body" x="${bx}" y="${BODY_Y}" width="${bw}" height="${BODY_H}" rx="${R}"/>
        <g clip-path="url(#tolyq-body)">
          <g clip-path="url(#tolyq-fill)" data-role="segments"></g>
        </g>

        <!-- дверной проём поверх груза: это всё-таки вагон, а не полоса -->
        <line class="wagon-rib" x1="${(bx + bw / 2 - 20).toFixed(1)}" y1="${BODY_Y + 3}" x2="${(bx + bw / 2 - 20).toFixed(1)}" y2="${BOT - 3}"/>
        <line class="wagon-rib" x1="${(bx + bw / 2 + 20).toFixed(1)}" y1="${BODY_Y + 3}" x2="${(bx + bw / 2 + 20).toFixed(1)}" y2="${BOT - 3}"/>
        <rect class="wagon-frame" x="${bx}" y="${BODY_Y}" width="${bw}" height="${BODY_H}" rx="${R}" fill="none"/>

        <!-- порог оптимальной остановки прямо на кузове -->
        <line class="wagon-thr" data-role="thr" x1="0" y1="${BODY_Y - 3}" x2="0" y2="${BOT + 3}"/>
        <text class="wagon-cap-text" data-role="thr-text" x="0" y="${BODY_Y - 11}" text-anchor="middle">порог</text>

        ${ticks.join('')}
        <text class="wagon-cap-text" x="${(bx + bw).toFixed(1)}" y="${BODY_Y - 11}" text-anchor="end">вместимость ${cap} т</text>
      </svg>`;

    dom.geom = { bx, bw, BODY_Y, BODY_H, cap };
    dom.clip = dom.wagon.querySelector('[data-role="clip"]');
    dom.segments = dom.wagon.querySelector('[data-role="segments"]');
    dom.thr = dom.wagon.querySelector('[data-role="thr"]');
    dom.thrText = dom.wagon.querySelector('[data-role="thr-text"]');
  }

  // ------------------------------------------------------------------
  //  Такт
  // ------------------------------------------------------------------
  function tick(clock) {
    if (!ctx || !dom) return;
    lastClock = clock;
    const { demo } = ctx;
    const h = clock.h;
    const state = demo.at(h);

    // --- новые заявки влетают карточками ---------------------------------
    for (const a of state.arrived) {
      if (seenKeys.has(a.key)) continue;
      seenKeys.add(a.key);
      dom.feed.appendChild(offerCard(a));
      if (a.accepted) addSegment(a);
      dom.feed.scrollTop = dom.feed.scrollHeight;
    }

    // --- налив: показываемое значение догоняет настоящее ------------------
    //  Сглаживаем только пока часы идут. На паузе и в нуле кадров больше не
    //  будет, и сглаживание навсегда застыло бы на полпути.
    const target = state.tons;
    if (clock.running) {
      shownTons += (target - shownTons) * EASE;
      if (Math.abs(target - shownTons) < 0.02) shownTons = target;
      shownCo2 += (state.co2Saved - shownCo2) * EASE;
      if (Math.abs(state.co2Saved - shownCo2) < 0.5) shownCo2 = state.co2Saved;
    } else {
      shownTons = target;
      shownCo2 = state.co2Saved;
    }

    const { bx, bw, cap } = dom.geom;
    dom.clip.setAttribute('width', ((shownTons / cap) * bw).toFixed(1));

    // --- порог -------------------------------------------------------------
    const thr = demo.thresholdAt(h);
    const tx = bx + (thr / cap) * bw;
    dom.thr.setAttribute('x1', tx.toFixed(1));
    dom.thr.setAttribute('x2', tx.toFixed(1));
    dom.thrText.setAttribute('x', tx.toFixed(1));

    // --- счётчики -----------------------------------------------------------
    dom.cTons.textContent   = fmt.tons(shownTons, shownTons % 1 > 0.05 ? 1 : 0);
    dom.cTrucks.textContent = fmt.withPlural(state.trucks, 'фура', 'фуры', 'фур');
    dom.cCo2.textContent    = fmt.co2(shownCo2);

    dom.clock.innerHTML =
      `час <b>${String(Math.floor(h)).padStart(2, '0')}</b> из ${demo.horizonH}` +
      ` · загрузка <b>${fmt.pct(Math.round(shownTons / cap * 100))}</b>`;

    dom.run.textContent = clock.running ? 'Пауза' : clock.finished ? 'Ещё раз' : 'Запустить';

    // --- отправка -----------------------------------------------------------
    if (state.departed && !departed) {
      departed = true;
      dom.wagon.classList.add('is-departed');
      dom.done.hidden = false;
      dom.done.textContent =
        `Порог пройден на ${fmt.hoursShort(demo.dispatchAtH)}: вагон уходит с ${fmt.tons(state.tons)} ` +
        `при вместимости ${cap} т. ${fmt.withPlural(state.trucks, 'фура', 'фуры', 'фур')} не поехали.`;
    }
  }

  function addSegment(a) {
    const { bx, bw, BODY_Y, BODY_H, cap } = dom.geom;
    const x = bx + (a.cumBefore / cap) * bw;
    const w = (a.tons / cap) * bw;
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'wagon-seg' + (a.mine ? ' wagon-seg--mine' : ''));
    rect.setAttribute('x', x.toFixed(1));
    rect.setAttribute('y', BODY_Y);
    rect.setAttribute('width', Math.max(0, w).toFixed(1));
    rect.setAttribute('height', BODY_H);
    rect.setAttribute('fill', a.mine ? 'var(--good)' : `var(${SHIP_COLORS[a.index % SHIP_COLORS.length]})`);
    dom.segments.appendChild(rect);
  }

  function offerCard(a) {
    const div = document.createElement('div');
    div.className = 'offer' + (a.accepted ? (a.mine ? ' offer--mine' : '') : ' offer--rejected');
    if (a.accepted && !a.mine) {
      div.style.borderLeftColor = `var(${SHIP_COLORS[a.index % SHIP_COLORS.length]})`;
    }
    div.innerHTML =
      `<span class="offer__name">${esc(a.shipper)}</span>
       <span class="offer__num">${fmt.tons(a.tons)} · ${fmt.num(a.volumeM3)} м³ · ${fmt.hoursShort(a.atH)}</span>
       ${a.accepted ? '' : `<span class="offer__reason">${esc(a.reason || 'не прошла упаковку')}</span>`}`;
    return div;
  }
}

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
