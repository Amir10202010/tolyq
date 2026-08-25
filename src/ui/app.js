// =====================================================================
//  TOLYQ / UI — СОСТОЯНИЕ И СВЯЗЫВАНИЕ ЭКРАНОВ
// ---------------------------------------------------------------------
//  Здесь живёт единственная копия состояния и единственные часы демо.
//  Все визуализации — чистые функции от него: получают state, рисуют,
//  сами ничего не считают и друг о друге не знают.
//
//  ЧАСЫ. Полоса загрузки, пороговая кривая и счётчики обязаны идти
//  синхронно. Поэтому такт один на всех (clock ниже), а не свой
//  requestAnimationFrame в каждом модуле.
// =====================================================================

import * as engine from './mock.js';          // <- ПРИ ИНТЕГРАЦИИ: '../core/engine.js'
import { NODES } from '../core/types.js';
import * as fmt from './format.js';
import { createForm } from './form.js';
import { createPareto, registerNames } from './pareto.js';
import { createNetworkMap } from './network-map.js';
import { createLoadbar } from './loadbar.js';
import { createStopping } from './stopping.js';
import { createSummary } from './summary.js';
import { explainSolution, getModelInfo } from './explain.js';

registerNames(NODES);

// ---------------------------------------------------------------------
//  Демо-сценарий. На защите руками не вводится ничего.
// ---------------------------------------------------------------------
const DEMO_REQUEST = {
  from: 'AST', to: 'ALA',
  tons: 8, volumeM3: 52,
  cargoType: 'food',
  deadlineH: 48,
  weights: { cost: 0.5, time: 0.3, co2: 0.2 },
};

const state = {
  request: { ...DEMO_REQUEST },
  solution: null,
  month: null,
  demo: null,             // производные данные сцены сборки вагона
  hovered: null,          // маршрут под курсором: связка Парето ↔ карта
};

// ---------------------------------------------------------------------
//  ЧАСЫ ДЕМО — одни на всю сцену
//  Полоса загрузки, пороговая кривая и счётчики читают этот такт. Свой
//  requestAnimationFrame в каждом модуле означал бы три слегка разных
//  времени и разъезжающуюся картинку.
// ---------------------------------------------------------------------
const clock = {
  h: 0,
  running: false,
  finished: false,
  secPerHour: 0.85,       // примерно секунда реального времени на час модели
  stopAtH: 18,
  raf: null,
  t0: 0,
  h0: 0,
};
const clockSubs = [];
const onClock = fn => clockSubs.push(fn);

const el = id => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------
//  Сборка
// ---------------------------------------------------------------------
const pareto = createPareto(el('pareto-chart'), {
  onHover: route => setHovered(route),
});

const map = createNetworkMap(el('network-chart'));

const loadbar = createLoadbar(el('loadbar-body'), {
  controls: { toggle: clockToggle, reset: clockReset },
});
const stopping = createStopping(el('stopping-body'));
const summary  = createSummary(el('month-body'));

onClock(c => { loadbar.tick(c); stopping.tick(c); });

const form = createForm(document.getElementById('form'), {
  initial: DEMO_REQUEST,
  onChange: req => recompute(req),
});

// ---------------------------------------------------------------------
//  Пересчёт
// ---------------------------------------------------------------------
function recompute(request) {
  state.request = request;
  state.solution = engine.solve(request);
  state.month = engine.runMonth(request.from, request.to);
  state.demo = buildDemo(state.solution, request);
  state.hovered = null;   // маршруты пересобрались, старая ссылка протухла

  renderMasthead();
  renderRecommend();
  pareto.update(state.solution, state.request);

  map.update(engine.getNetwork(), state.request);
  map.showRoute(state.solution.recommended);
  renderNetworkMeta();

  const ctx = { request, solution: state.solution, demo: state.demo };
  loadbar.update(ctx);
  stopping.update(ctx);
  summary.update(state.month);

  el('loadbar-meta').textContent =
    `вместимость ${fmt.tons(state.demo.capacityTons)} · ${fmt.num(state.demo.capacityM3)} м³`;
  el('stopping-meta').textContent = `горизонт ${fmt.hoursShort(state.demo.horizonH)}`;
  el('month-meta').textContent =
    `средняя загрузка ${fmt.pct(state.month.avgFillPct)}`;

  clockReset();
}

/**
 * Связка двух визуализаций. Ради неё всё и затевалось: точка на фронте
 * под курсором мгновенно показывает, каким путём по сети она получена.
 */
function setHovered(route) {
  state.hovered = route;
  map.showRoute(route || state.solution.recommended);
  renderNetworkMeta();
}

// ---------------------------------------------------------------------
//  ДАННЫЕ СЦЕНЫ СБОРКИ
//  Всё, что нужно полосе и кривой, считается здесь один раз, а модули
//  спрашивают состояние на конкретный час. Ни у полосы, ни у кривой
//  своей памяти о ходе времени нет — поэтому они не могут разойтись.
// ---------------------------------------------------------------------
function buildDemo(sol, req) {
  const st = sol.stopping;
  const cap = engine.CONSTANTS.WAGON_TONS;
  const capM3 = engine.CONSTANTS.WAGON_M3;

  const raw = [...sol.packing.accepted, ...sol.packing.rejected]
    .slice()
    .sort((a, b) => a.atH - b.atH);

  let cum = 0, colorIndex = 0;
  const arrivals = raw.map(a => {
    const rec = {
      ...a,
      key: `${a.shipper}@${a.atH}`,
      index: a.mine ? -1 : colorIndex,
      cumBefore: cum,
      trucks: trucksFor(a),
    };
    if (a.accepted) { cum += a.tons; if (!a.mine) colorIndex++; }
    return rec;
  });

  // Опорные величины для счётчиков. Эталон «грязного» варианта — фура,
  // эталон «чистого» — самый малоуглеродный маршрут фронта, а не
  // рекомендованный: при жёстком сроке рекомендованным может оказаться
  // сама фура, и экономия схлопнулась бы в ноль на ровном месте.
  const greenest = sol.pareto.reduce((b, r) => (r.co2Kg < b.co2Kg ? r : b), sol.pareto[0]);
  const perTruckCo2 = sol.truckBaseline.co2Kg / (sol.truckBaseline.trucks || 1);
  const railPerTon  = greenest.co2Kg / Math.max(0.5, req.tons);

  return {
    horizonH: st.horizonH,
    dispatchAtH: st.dispatchAtH,
    capacityTons: cap,
    capacityM3: capM3,
    arrivals,

    /** Порог между целыми часами берём линейно — точка должна ехать плавно. */
    thresholdAt(h) {
      const arr = st.thresholdByHour;
      const t = Math.min(arr.length - 1, Math.max(0, h));
      const i = Math.floor(t), f = t - i;
      return i >= arr.length - 1 ? arr[arr.length - 1] : arr[i] + (arr[i + 1] - arr[i]) * f;
    },

    /** Состояние сцены на час h. Чистая функция, памяти нет. */
    at(h) {
      const arrived = arrivals.filter(a => a.atH <= h);
      const accepted = arrived.filter(a => a.accepted);
      const tons = accepted.reduce((s, a) => s + a.tons, 0);
      const trucks = accepted.reduce((s, a) => s + a.trucks, 0);
      return {
        arrived, accepted, tons, trucks,
        co2Saved: Math.max(0, perTruckCo2 * trucks - railPerTon * tons),
        departed: h >= st.dispatchAtH,
      };
    },
  };
}

/** Сколько машин заказал бы этот отправитель, если бы поехал один. */
function trucksFor(a) {
  return Math.max(1,
    Math.ceil(a.tons / engine.CONSTANTS.TRUCK_TONS),
    Math.ceil(a.volumeM3 / engine.CONSTANTS.TRUCK_M3));
}

// ---------------------------------------------------------------------
//  Часы
// ---------------------------------------------------------------------
function clockToggle() {
  if (clock.running) { clockPause(); return; }
  if (clock.finished) { clockReset(); }
  clock.running = true;
  clock.finished = false;
  clock.t0 = performance.now();
  clock.h0 = clock.h;
  clockLoop();
  clockEmit();
}

function clockPause() {
  clock.running = false;
  if (clock.raf) cancelAnimationFrame(clock.raf);
  clock.raf = null;
  clockEmit();
}

function clockReset() {
  if (clock.raf) cancelAnimationFrame(clock.raf);
  clock.raf = null;
  clock.running = false;
  clock.finished = false;
  clock.h = 0;
  clock.stopAtH = state.demo
    ? Math.min(state.demo.horizonH, state.demo.dispatchAtH + 5)
    : 18;
  loadbar.reset();
  stopping.reset();
  clockEmit();
}

function clockLoop() {
  clock.raf = requestAnimationFrame(now => {
    if (!clock.running) return;
    clock.h = clock.h0 + (now - clock.t0) / 1000 / clock.secPerHour;
    if (clock.h >= clock.stopAtH) {
      clock.h = clock.stopAtH;
      clock.running = false;
      clock.finished = true;
    }
    clockEmit();
    if (clock.running) clockLoop();
  });
}

function clockEmit() {
  for (const fn of clockSubs) fn(clock);
}

function renderNetworkMeta() {
  const net = engine.getNetwork();
  const shown = state.hovered || state.solution.recommended;
  el('network-meta').textContent =
    `${net.nodes.length} узлов · ${net.edges.length} рёбер`;
  el('network-note').innerHTML = shown
    ? `Показан маршрут <b>«${esc(shown.label)}»</b>: ${fmt.km(shown.km ?? legKm(shown))},
       ${fmt.hoursShort(shown.hours)}. Сплошные линии — железная дорога, штриховые — автодороги.`
    : 'Сплошные линии — железная дорога, штриховые — автодороги.';
}

const legKm = r => r.legs.reduce((s, l) => s + l.km, 0);

// ---------------------------------------------------------------------
//  Шапка
// ---------------------------------------------------------------------
function renderMasthead() {
  const { request: req, solution: sol } = state;

  el('corridor-from').textContent = nameOf(req.from);
  el('corridor-to').textContent   = nameOf(req.to);
  el('corridor-rest').textContent = [
    fmt.tons(req.tons, req.tons % 1 ? 1 : 0),
    fmt.num(req.volumeM3) + ' м³',
    engine.CARGO_TYPES[req.cargoType].toLowerCase(),
    'срок ' + fmt.hoursShort(req.deadlineH),
  ].join(' · ');

  const flat = sol.savingKzt <= 0;
  el('headline').classList.toggle('headline--flat', flat);
  el('headline-co2').textContent = flat
    ? 'дешевле уже некуда'
    : '−' + fmt.co2(sol.savingCo2Kg) + ' CO₂';

  rollNumber(el('headline-kzt'), Math.max(0, sol.savingKzt), v => fmt.kzt(v));

  el('pareto-meta').textContent =
    `${sol.pareto.length} на фронте из ${sol.considered ?? (sol.pareto.length + sol.dominated.length)}`;
  el('request-meta').textContent = 'пересчёт живой';
}

// ---------------------------------------------------------------------
//  Рекомендация
// ---------------------------------------------------------------------
let explainToken = 0;

function renderRecommend() {
  const { request: req, solution: sol } = state;
  const rec = sol.recommended;
  const noneFeasible = !sol.pareto.some(r => r.feasible);

  // Стоянку на перегрузку берём как разницу между итогом маршрута и суммой
  // плеч. Если движок уже зашил её внутрь leg.hours, разница будет нулевой —
  // тогда печатаем строку без часов, но строки всё равно сойдутся с итогом.
  const legSum = rec.legs.reduce((s, l) => s + l.hours, 0);
  const shipCount = rec.legs.filter(l => l.transshipment).length;
  const shipH = shipCount ? (rec.hours - legSum) / shipCount : 0;

  const legs = rec.legs.map(l => {
    const rows = [];
    if (l.transshipment) {
      rows.push(`<div class="leg leg--transship">
        <span class="leg__pin"><i></i></span>
        <span class="leg__text">Перегрузка в узле ${nameOf(l.from)}</span>
        <span class="leg__num">${shipH > 0.05 ? fmt.hoursShort(shipH) : ''}</span>
      </div>`);
    }
    rows.push(`<div class="leg leg--${l.mode}">
      <span class="leg__pin"><i></i></span>
      <span class="leg__text"><b>${nameOf(l.from)} — ${nameOf(l.to)}</b>,
        ${l.mode === 'rail' ? 'железная дорога' : 'автотранспорт'}</span>
      <span class="leg__num">${fmt.km(l.km)} · ${fmt.hoursShort(l.hours)}</span>
    </div>`);
    return rows.join('');
  }).join('');

  el('recommend-meta').textContent = rec.multimodal ? 'мультимодальный' : 'один вид транспорта';

  el('recommend-body').innerHTML = `
    <div class="rec">
      <p class="rec__label">${esc(rec.label)}</p>

      <div class="rec__figures">
        <div class="figure figure--go">
          <span class="figure__label">Стоимость</span>
          <span class="figure__value">${fmt.kzt(rec.costKzt)}</span>
        </div>
        <div class="figure">
          <span class="figure__label">Срок</span>
          <span class="figure__value">${fmt.hoursHuman(rec.hours)}</span>
        </div>
        <div class="figure">
          <span class="figure__label">Выбросы</span>
          <span class="figure__value">${fmt.co2(rec.co2Kg)}</span>
        </div>
      </div>

      <div class="rec__legs">${legs}</div>

      ${noneFeasible ? `<p class="rec__warn">Ни один вариант не укладывается в
         ${fmt.hoursShort(req.deadlineH)}. Показан лучший из непроходящих —
         увеличьте срок или разбейте партию.</p>` : ''}

      <div class="why" id="why">
        <div class="why__head"><h3 class="why__title">Почему так</h3></div>
        <p class="why__text">${esc(sol.explanation)}</p>
      </div>
    </div>`;

  // Полный разбор приходит асинхронно: движок может ходить в сеть.
  // До его прихода в блоке уже стоит живой текст, а не заглушка.
  const token = ++explainToken;
  explainSolution(sol, req).then(res => {
    if (token !== explainToken) return;
    const box = el('why');
    if (!box || !res.paragraphs?.length) return;
    box.innerHTML =
      `<div class="why__head"><h3 class="why__title">Почему так</h3></div>` +
      res.paragraphs.map(p => `<p class="why__text">${p}</p>`).join('');
  }).catch(() => { /* остаётся текст движка — этого достаточно */ });
}

// ---------------------------------------------------------------------
//  Статус модели под пороговой кривой
// ---------------------------------------------------------------------
function renderModelNote() {
  getModelInfo().then(info => {
    const node = el('model-note');
    if (!node || !info?.text) return;
    node.textContent = info.text;
    node.classList.toggle('model-note--cold', !info.live);
  }).catch(() => {});
}

// ---------------------------------------------------------------------
//  Мелочи
// ---------------------------------------------------------------------

/** Число в шапке не подменяется, а доезжает: видно, что оно поменялось. */
function rollNumber(node, target, format) {
  const from = Number(node.dataset.value || 0);
  node.dataset.value = String(target);
  if (REDUCED || Math.abs(target - from) < 1) {
    node.textContent = format(target);
    return;
  }
  node.textContent = format(target);   // итог проставляем сразу: если кадры
                                       // не идут (вкладка не отрисовывается),
                                       // на экране всё равно верное число
  const t0 = performance.now();
  const dur = 420;
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = format(from + (target - from) * e);
    if (k < 1 && node.dataset.value === String(target)) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function stub(id, text) {
  const node = el(id);
  if (node) node.innerHTML = `<p class="stub">${text}</p>`;
}

// Объявлены функциями, а не стрелками: модуль вызывает recompute() на
// верхнем уровне, до этих строк, и const попал бы во временную мёртвую зону.
function nameOf(id) {
  return NODES.find(n => n.id === id)?.name || id;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------------------------------------------------------------
//  Первый расчёт — последней строкой модуля, чтобы всё выше было объявлено
// ---------------------------------------------------------------------
recompute(state.request);
renderModelNote();
