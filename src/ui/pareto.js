// =====================================================================
//  TOLYQ / UI — ФРОНТ ПАРЕТО
// ---------------------------------------------------------------------
//  По горизонтали срок, по вертикали деньги, размер точки — выбросы.
//  Три критерия читаются одновременно, поэтому и график один, а не три.
//
//  Оси начинаются от нуля осознанно: только так видно, что фура стоит
//  вчетверо дороже вагона, а не «немного правее по шкале».
//
//  Обе шкалы «чем меньше, тем лучше» — а это читается не сразу: на
//  привычных графиках вверх и вправо означает «больше и лучше». Поэтому
//  в пустом левом нижнем углу стоит стрелка «лучше»: угол там пуст не
//  случайно, самого дешёвого и одновременно самого быстрого варианта не
//  бывает, и место под подсказку освобождается само.
//
//  Выбранный вариант ЗАКРЕПЛЯЕТСЯ щелчком. Наведение хорошо ровно до
//  того момента, пока человек не захотел разглядеть маршрут на карте
//  рядом: убрал курсор с точки — и подсветка пропала.
//
//  SVG рисуется в честных экранных пикселях (viewBox = размер контейнера),
//  а не масштабируется. Иначе подписи на телефоне уезжают в 6 px.
// =====================================================================

import * as fmt from './format.js';

const M = { top: 22, right: 20, bottom: 40, left: 64 };
// Разброс радиусов сужен: прежние 4.2–13 px превращали фронт в россыпь
// разнокалиберных клякс, и форма компромисса — то, ради чего график и
// нужен, — терялась за перепадом размеров. Выбросы по-прежнему видно,
// но они больше не главный сигнал на картинке.
const R_MIN = 5, R_MAX = 9.5;

export function createPareto(root, { onHover, onPick } = {}) {
  const tip = document.getElementById('pareto-tip');
  if (tip && tip.parentElement !== root) root.appendChild(tip);

  let data = null;        // { solution, request }
  let hotId = null;       // под курсором прямо сейчас
  let pinId = null;       // закреплён щелчком и переживает уход курсора
  let tipOn = false;      // карточка с числами: её показывает только наведение
  let frame = null;
  let geom = null;        // положение точек после последней отрисовки

  const ro = new ResizeObserver(() => schedule());
  ro.observe(root);

  return { update, setHot, setPin, clear: () => setHot(null) };

  // ------------------------------------------------------------------

  /** Смена данных рисуется сразу: ждать кадра тут нечего. */
  function update(solution, request) {
    data = { solution, request };
    if (hotId && !findRoute(hotId)) hotId = null;
    if (pinId && !findRoute(pinId)) pinId = null;
    render();
  }

  /** А вот поток событий от ResizeObserver склеиваем в один кадр. */
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; render(); });
  }

  function setHot(id, { showTip = false } = {}) {
    hotId = id;
    tipOn = showTip && !!id;
    paint();
  }

  /** Закрепление приходит и снаружи: коротким списком под графиком. */
  function setPin(id) {
    pinId = id;
    paint();
  }

  /**
   * Единственное место, где решается, что подсвечено. Наведение сильнее
   * закрепления: пока курсор на точке, показываем её, а отпустили —
   * возвращаемся к закреплённой, а не к пустоте.
   *
   * Карточка с числами привязана к наведению, а не к подсветке: висеть
   * поверх графика постоянно она не должна — закрывает соседние точки.
   */
  function paint() {
    if (!geom) return;
    const liveId = hotId || pinId;
    for (const g of geom.nodes) {
      g.el.classList.toggle('is-hot', g.id === liveId);
      g.el.classList.toggle('is-pinned', g.id === pinId);
      if (g.id === liveId) g.el.parentNode.appendChild(g.el);   // поднять над остальными
    }
    const hit = geom.nodes.find(g => g.id === liveId);
    if (hit && tipOn) showTipFor(hit);
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

    // --- КАДР ОСЕЙ ------------------------------------------------------
    //  Масштаб задают те варианты, между которыми человек в самом деле
    //  выбирает: фронт и «как везут сегодня». Раньше его задавал максимум
    //  по ВСЕМ точкам — и один отброшенный вариант за полтора миллиона
    //  тенге сплющивал весь фронт в нижнюю десятую часть полотна. Три
    //  главные точки стояли в двадцати пикселях друг от друга: график, за
    //  которым сюда и приходят, не показывал ровно ничего.
    //
    //  Всё, что осталось за кадром, не выбрасывается: такая точка
    //  прижимается к краю и помечается уголком. Числа у неё честные —
    //  видны в карточке по наведению и целиком в таблице.
    const decisive = [...sol.pareto, sol.truckBaseline, sol.recommended].filter(Boolean);
    const decKzt = Math.max(...decisive.map(r => r.costKzt));
    const decH   = Math.max(...decisive.map(r => r.hours));

    const maxKzt = Math.max(decKzt * 1.10, 1);
    // Срок берём в кадр, только если он рядом с данными. Дедлайн в 240 ч
    // при вариантах на 40 отжал бы фронт к левому краю ровно так же, как
    // это делал выброс по деньгам, — поэтому есть потолок в 1.75 длины.
    const maxH = Math.max(decH * 1.12, Math.min(req.deadlineH * 1.22, decH * 1.75), 1);

    const co2s   = points.map(p => p.r.co2Kg);
    const co2Lo  = Math.min(...co2s), co2Hi = Math.max(...co2s);

    // Точку за кадром прижимаем к краю, а не выпускаем за него: иначе
    // она уедет под подписи осей и станет неотличима от мусора.
    const EDGE = 8;
    const x = v => Math.min(M.left + (v / maxH) * plotW, M.left + plotW - EDGE);
    const y = v => Math.max(M.top + plotH - (v / maxKzt) * plotH, M.top + EDGE);
    const rad = v => co2Hi - co2Lo < 1e-6 ? 6
      : R_MIN + (R_MAX - R_MIN) * Math.sqrt((v - co2Lo) / (co2Hi - co2Lo));

    const parts = [];

    // --- зона за сроком ------------------------------------------------
    //  Раньше это была заливка непрозрачностью 2 %, то есть ничего.
    //  Косая штриховка читается и на проекторе, и в чёрно-белой распечатке,
    //  а на цвет не полагается вовсе: это область «сюда нельзя», и она
    //  обязана быть видна раньше, чем человек начнёт искать точки.
    // Срок может оказаться и за правым краем — тогда в кадре его нет, и
    // рисовать нечего: об этом скажет отдельная метка ниже.
    const deadlineIn = req.deadlineH <= maxH;
    const dx = M.left + (req.deadlineH / maxH) * plotW;
    const zoneW = M.left + plotW - dx;
    // Штриховку стелем, только если полоса достаточно широка, чтобы
    // что-то значить. Когда все варианты укладываются в срок с большим
    // запасом, от зоны остаётся полоска в десяток пикселей: это уже не
    // «сюда нельзя», а шум у самой рамки. Линия срока при этом остаётся
    // на месте — она и несёт весь смысл.
    if (deadlineIn && zoneW >= 34) {
      parts.push(`<defs>
        <pattern id="tolyq-late" width="7" height="7" patternUnits="userSpaceOnUse"
                 patternTransform="rotate(45)">
          <line class="late-hatch" x1="0" y1="0" x2="0" y2="7"/>
        </pattern>
      </defs>`);
      parts.push(`<rect class="deadline-zone" x="${dx.toFixed(1)}" y="${M.top}"
        width="${zoneW.toFixed(1)}" height="${plotH}" fill="url(#tolyq-late)"/>`);
      if (zoneW > 86) {
        parts.push(`<text class="deadline-zone-text" x="${(dx + zoneW / 2).toFixed(1)}"
          y="${(M.top + plotH - 9).toFixed(1)}" text-anchor="middle">позже срока</text>`);
      }
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

    // --- куда лучше: в пустой левый нижний угол -------------------------
    //  Угол свободен по устройству задачи: варианта, который одновременно
    //  и самый дешёвый, и самый быстрый, не существует — иначе не было бы
    //  и фронта. Значит, подсказку там ничем не заслонит.
    {
      const ax = M.left + 14, ay = M.top + plotH - 14;
      const bx = M.left + 52, by = M.top + plotH - 52;
      parts.push(`<g class="better" aria-hidden="true">
        <path class="better__arrow" d="M ${bx} ${by} L ${ax} ${ay} M ${ax + 11} ${ay} L ${ax} ${ay} L ${ax} ${ay - 11}"/>
        <text class="better__text" x="${bx + 6}" y="${by - 3}">лучше</text>
      </g>`);
    }

    // --- линия срока ---------------------------------------------------
    if (deadlineIn) {
      parts.push(`<line class="deadline-line" x1="${dx.toFixed(1)}" y1="${M.top}" x2="${dx.toFixed(1)}" y2="${M.top + plotH}"/>`);
      const anchor = dx > M.left + plotW - 70 ? 'end' : 'start';
      const tx = anchor === 'end' ? dx - 5 : dx + 5;
      parts.push(`<text class="deadline-text" x="${tx.toFixed(1)}" y="${M.top + 10}" text-anchor="${anchor}">срок ${Math.round(req.deadlineH)} ч</text>`);
    } else {
      // Срок дальше правого края — значит в него укладываются все
      // варианты в кадре. Молчать об этом нельзя: человек ищет линию
      // срока глазами и, не найдя, решает, что её забыли нарисовать.
      parts.push(`<text class="deadline-text deadline-text--far" x="${(M.left + plotW).toFixed(1)}"
        y="${M.top + 10}" text-anchor="end">срок ${Math.round(req.deadlineH)} ч — дальше края</text>`);
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
      const px = x(p.r.hours), py = y(p.r.costKzt);
      const overKzt = p.r.costKzt > maxKzt;
      const overH   = p.r.hours   > maxH;
      // У точки за кадром размер больше ничего не кодирует: её положение
      // и так условно, и крупный кружок у самого края читался бы как
      // полноценный вариант. Оставляем маленькую метку — она про то,
      // что вариант есть, а не про то, сколько он стоит.
      const pr = (overKzt || overH) ? 3.2 : rad(p.r.co2Kg);
      const cls = ['pt', `pt--${p.kind}`];
      if (!p.r.feasible) cls.push('pt--infeasible');
      if (overKzt || overH) cls.push('pt--off');

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

      // Уголок «за шкалой». Точка прижата к краю, и без пометки она
      // соврала бы: встала бы в один ряд с теми, что в кадре, будто
      // стоит столько же. Уголок смотрит туда, куда точка ушла.
      const off = (overKzt || overH)
        ? caret(px, py, pr, overH ? 1 : 0, overKzt ? -1 : 0)
        : '';

      // Точка — не картинка, а орган управления: по ней щёлкают, чтобы
      // закрепить вариант, и на неё встают с клавиатуры.
      const outNote = overKzt && overH ? ' — дороже и дольше шкалы'
                    : overKzt ? ' — дороже шкалы'
                    : overH ? ' — дольше шкалы' : '';
      parts.push(`<g class="${cls.join(' ')}" data-id="${p.r.id}" role="button" tabindex="0"
        aria-label="${esc(p.r.label)}: ${fmt.kzt(p.r.costKzt)}, ${fmt.hoursShort(p.r.hours)}, ${fmt.co2(p.r.co2Kg)}${outNote}">
        <circle class="pt__halo" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${(pr + 5).toFixed(1)}"/>
        ${mark}${off}
        <circle class="pt__hit" cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="${Math.max(13, pr + 8).toFixed(1)}" fill="transparent"/>
      </g>`);

      nodes.push({ id: p.r.id, route: p.r, kind: p.kind, px, py, pr });
    }

    // --- подписи двух опорных точек ------------------------------------
    //  Ставим начерно, а разбираем после вставки: настоящую ширину
    //  капительной строки до отрисовки не знает никто, а прикидка по
    //  числу знаков врёт на десяток пикселей — ровно столько, чтобы
    //  подпись «везут сегодня» легла поверх соседней точки.
    for (const key of ['base', 'rec']) {
      const n = nodes.find(v => v.kind === key);
      if (!n) continue;
      // Подписи набраны капителью и потому длинные не влезают: у опорной
      // точки оставлено два слова, полная формулировка есть в подсказке.
      const label = key === 'rec' ? 'рекомендуем' : 'везут сегодня';
      parts.push(`<text class="pt__label pt__label--${key}" data-anchor="${key}"
        x="${n.px.toFixed(1)}" y="${n.py.toFixed(1)}" text-anchor="start">${label}</text>`);
    }

    const anyOff = points.some(p => p.r.costKzt > maxKzt || p.r.hours > maxH);
    const anyMiss = points.some(p => !p.r.feasible);

    root.innerHTML =
      `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="group"
            aria-label="Фронт Парето: стоимость против срока, размер точки — выбросы CO₂">
         ${parts.join('')}
       </svg>` + legendHtml({ anyOff, anyMiss });
    if (tip) root.appendChild(tip);

    // --- события --------------------------------------------------------
    const svg = root.querySelector('svg');
    placeAnchorLabels(svg, nodes, { left: M.left, top: M.top, right: M.left + plotW, bottom: M.top + plotH });
    for (const n of nodes) {
      n.el = svg.querySelector(`.pt[data-id="${cssEsc(n.id)}"]`);
      if (!n.el) continue;
      n.el.addEventListener('pointerenter', () => hover(n));
      n.el.addEventListener('pointerdown', () => hover(n));
      n.el.addEventListener('pointerleave', e => {
        if (e.pointerType === 'touch') return;
        leave();
      });
      n.el.addEventListener('click', () => toggle(n));
      // С клавиатуры точка ведёт себя ровно как под курсором
      n.el.addEventListener('focus', () => hover(n));
      n.el.addEventListener('blur', () => leave());
      n.el.addEventListener('keydown', e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        toggle(n);
      });
    }
    svg.addEventListener('pointerleave', leave);

    geom = { nodes, w, h, maxKzt, maxH };
    paint();
  }

  function hover(n) {
    hotId = n.id;
    tipOn = true;
    paint();
    onHover?.(n.route);
  }

  function leave() {
    hotId = null;
    tipOn = false;
    paint();
    onHover?.(null);
  }

  /** Щелчок по закреплённой точке снимает закрепление: иначе из него не выйти. */
  function toggle(n) {
    pinId = pinId === n.id ? null : n.id;
    paint();
    onPick?.(pinId ? n.route : null);
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

    // Точка прижата к краю — говорим об этом прямо. Числа в строках выше
    // настоящие, но её ПОЛОЖЕНИЕ на графике врёт, и молчать нельзя.
    const outOf = r.costKzt > geom.maxKzt || r.hours > geom.maxH
      ? `<p class="tip__off">точка прижата к краю: вариант ${
          r.costKzt > geom.maxKzt && r.hours > geom.maxH ? 'дороже и дольше'
          : r.costKzt > geom.maxKzt ? 'дороже' : 'дольше'} шкалы</p>`
      : '';

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
       ${outOf}${flag}`;
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
 * ровно ничего.
 *
 * Шесть ключей в один поток заворачивались в три рваные строки, и
 * легенда занимала больше места, чем нижняя треть самого графика.
 * Теперь их два ряда с ясным делением: сверху — ЧТО за точка (цвет),
 * снизу — КАК она нарисована (форма и размер). Ключи, которым на этом
 * наборе данных нечего объяснять, не печатаются вовсе: подпись про
 * «не успевает» при отсутствии крестиков — чистый шум.
 */
function legendHtml({ anyOff = false, anyMiss = false } = {}) {
  const shape = [
    anyMiss ? `<span class="legend__item"><i class="legend__cross"></i>не успевает</span>` : '',
    `<span class="legend__item"><i class="legend__size"></i>размер — выбросы CO₂</span>`,
    anyOff ? `<span class="legend__item"><i class="legend__off"></i>за краем шкалы</span>` : '',
  ].filter(Boolean).join('');

  return `<div class="legend legend--chart">
    <div class="legend__row">
      <span class="legend__item"><i class="legend__dot legend__dot--rec"></i>наш выбор</span>
      <span class="legend__item"><i class="legend__dot legend__dot--front"></i>тоже хорошие</span>
      <span class="legend__item"><i class="legend__dot legend__dot--base"></i>так возят сейчас</span>
      <span class="legend__item"><i class="legend__dot legend__dot--dim"></i>хуже по всему</span>
    </div>
    <div class="legend__row legend__row--quiet">${shape}</div>
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

// ---------------------------------------------------------------------
//  РАССТАНОВКА ДВУХ ОПОРНЫХ ПОДПИСЕЙ
//  «рекомендуем» и «везут сегодня» — единственный текст внутри поля
//  графика, и лечь на чужую точку он не имеет права: подпись поверх
//  кружка не читается сама и прячет вариант под собой.
//
//  Пробуем шесть положений вокруг своей точки и берём первое, которое
//  не задевает ни одну другую точку и не вылезает из поля. Не подошло
//  ни одно — оставляем последнее: подпись у опорной точки нужнее
//  идеального зазора, а совсем убрать её нельзя, иначе на графике
//  пропадёт ответ.
// ---------------------------------------------------------------------
const LABEL_SPOTS = [
  [ 1, -1, 'start'],   // справа сверху
  [-1, -1, 'end'],     // слева сверху
  [ 1,  1, 'start'],   // справа снизу
  [-1,  1, 'end'],     // слева снизу
  [ 0, -1, 'middle'],  // над точкой
  [ 0,  1, 'middle'],  // под точкой
];

function placeAnchorLabels(svg, nodes, box) {
  if (!svg) return;

  // Точки — препятствия. Своя точка тоже: подпись обходит и её.
  const blocks = nodes.map(n => ({
    x: n.px - n.pr - 2, y: n.py - n.pr - 2,
    width: n.pr * 2 + 4, height: n.pr * 2 + 4,
  }));

  for (const el of svg.querySelectorAll('.pt__label')) {
    const n = nodes.find(v => v.kind === el.dataset.anchor);
    if (!n) continue;

    for (const [sx, sy, anchor] of LABEL_SPOTS) {
      const dx = sx === 0 ? 0 : sx * (n.pr + 7);
      const dy = sy < 0 ? -(n.pr + 7) : (n.pr + 14);
      el.setAttribute('x', (n.px + dx).toFixed(1));
      el.setAttribute('y', (n.py + dy).toFixed(1));
      el.setAttribute('text-anchor', anchor);

      const b = el.getBBox();
      const r = { x: b.x - 2, y: b.y - 1, width: b.width + 4, height: b.height + 2 };
      if (r.x < box.left - 2 || r.x + r.width > box.right + 2) continue;
      if (r.y < box.top || r.y + r.height > box.bottom) continue;
      if (blocks.some(t => hits(t, r))) continue;
      break;
    }
  }
}

const hits = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width &&
  a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Уголок у точки, прижатой к краю кадра. Смотрит в ту сторону, куда
 * вариант ушёл за шкалу: вверх — дороже, вправо — дольше, наискось —
 * и то и другое.
 */
function caret(px, py, pr, dirX, dirY) {
  const len = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / len, uy = dirY / len;
  const cx = px + ux * (pr + 6), cy = py + uy * (pr + 6);
  const ang = Math.atan2(uy, ux) * 180 / Math.PI;
  return `<path class="pt__off" d="M -2.6 -3.2 L 0.8 0 L -2.6 3.2"
    transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${ang.toFixed(1)})"/>`;
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
