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

const el = id => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

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
//  РАЗДЕЛЫ
//  Три вопроса, на которые отвечает система, разведены по вкладкам:
//  вываливать всё сразу на одну простыню — и есть та каша, из-за которой
//  непонятно, что где. Вердикт при этом закреплён над вкладками и виден
//  всегда: переключаются доказательства, а не ответ.
//
//  Адреса вида #/route — обычные ссылки: работает «назад» и адрес можно
//  переслать. Полноценные отдельные страницы потребовали бы перезагрузки
//  и обнуляли бы анимацию сборки на каждом переходе.
// ---------------------------------------------------------------------
const VIEWS = ['route', 'timing', 'impact'];

function currentView() {
  const h = location.hash.replace(/^#\/?/, '').trim();
  return VIEWS.includes(h) ? h : VIEWS[0];
}

function applyView() {
  const v = currentView();

  for (const s of document.querySelectorAll('.view')) {
    s.classList.toggle('is-active', s.dataset.view === v);
  }
  for (const a of document.querySelectorAll('.nav__tab')) {
    if (a.dataset.view === v) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }

  // Ушли со сцены сборки — останавливаем часы, чтобы вагон не уехал
  // за кадром и человек не вернулся к уже закончившейся анимации.
  if (v !== 'timing' && clock.running) clockPause();

  // Лента маршрута и разбор словами относятся к разделу «Чем везти».
  // На других вкладках они только отталкивают содержимое за экран,
  // поэтому там от вердикта остаётся сам ответ и экономия.
  el('verdict').classList.toggle('verdict--compact', v !== 'route');

  refreshView(v);
}

/**
 * Скрытый график имеет нулевую ширину и потому не рисуется. При показе
 * раздела просим его модули перерисоваться — но БЕЗ сброса: часы демо
 * продолжают показывать тот же час, что и до ухода.
 */
function refreshView(v) {
  if (!state.solution) return;
  if (v === 'route') {
    pareto.update(state.solution, state.request);
    map.update(engine.getNetwork(), state.request);
    map.showRoute(state.hovered || state.solution.recommended);
  } else if (v === 'timing') {
    loadbar.refresh();
    stopping.refresh();
  } else if (v === 'impact') {
    summary.update(state.month);
  }
}

window.addEventListener('hashchange', applyView);

// ---------------------------------------------------------------------
//  Заявка на узком экране: свёрнута в строку, разворачивается кнопкой
// ---------------------------------------------------------------------
const aside = el('aside');
const asideToggle = el('aside-toggle');
asideToggle.addEventListener('click', () => {
  const open = aside.classList.toggle('is-open');
  asideToggle.setAttribute('aria-expanded', String(open));
  asideToggle.textContent = open ? 'Свернуть' : 'Изменить';
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

  renderVerdict();
  pareto.update(state.solution, state.request);

  map.update(engine.getNetwork(), state.request);
  map.showRoute(state.solution.recommended);
  renderNetworkMeta();

  const ctx = { request, solution: state.solution, demo: state.demo };
  loadbar.update(ctx);
  stopping.update(ctx);
  summary.update(state.month);

  const sol = state.solution;
  el('pareto-meta').textContent =
    `${sol.pareto.length} из ${sol.considered ?? (sol.pareto.length + sol.dominated.length)}`;
  el('loadbar-meta').textContent = `вагон ${fmt.tons(state.demo.capacityTons)}`;
  el('stopping-meta').textContent = `горизонт ${fmt.hoursShort(state.demo.horizonH)}`;
  el('month-meta').textContent = `загрузка ${fmt.pct(state.month.avgFillPct)}`;

  el('aside-summary').textContent = [
    `${fmt.tons(request.tons, request.tons % 1 ? 1 : 0)} ${engine.CARGO_TYPES[request.cargoType].toLowerCase()}`,
    `${nameOf(request.from)} → ${nameOf(request.to)}`,
    fmt.hoursShort(request.deadlineH),
  ].join(' · ');

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
//  РЕШЕНИЕ
//  Первое, что видит человек, — готовый ответ. Маршрут показан лентой
//  слева направо: так плечи и перегрузка читаются с одного взгляда,
//  а не собираются в голове из списка строк.
// ---------------------------------------------------------------------
let lastSaving = 0;
let explainToken = 0;

function renderVerdict() {
  const { request: req, solution: sol } = state;
  const rec = sol.recommended;
  const base = sol.truckBaseline;
  const noneFeasible = !sol.pareto.some(r => r.feasible);
  const flat = sol.savingKzt <= 0;

  const costCut = base.costKzt > 0 ? Math.round(sol.savingKzt / base.costKzt * 100) : 0;
  const co2Cut  = base.co2Kg  > 0 ? Math.round(sol.savingCo2Kg / base.co2Kg * 100) : 0;

  const stats = [
    ['Стоимость',      fmt.kzt(rec.costKzt)],
    ['Срок',           fmt.hoursHuman(rec.hours)],
    ['Выбросы',        fmt.co2(rec.co2Kg)],
    ['Загрузка вагона', fmt.pct(rec.fillPct)],
  ];

  // Ответ должен быть виден вместе с вопросом, иначе цифры висят в воздухе
  const ask = [
    `${fmt.tons(req.tons, req.tons % 1 ? 1 : 0)} · ${engine.CARGO_TYPES[req.cargoType].toLowerCase()}`,
    `${nameOf(req.from)} → ${nameOf(req.to)}`,
    `срок ${fmt.hoursShort(req.deadlineH)}`,
  ].join('  ·  ');

  el('verdict').innerHTML = `
    <div class="verdict__top">
      <div>
        <p class="verdict__eyebrow">${flat ? 'Лучшее из возможного' : 'Рекомендуем'}</p>
        <h1 class="verdict__title">${esc(rec.label)}</h1>
        <p class="verdict__ask">${esc(ask)}</p>
        <ul class="verdict__stats">
          ${stats.map(([k, v]) => `<li class="vstat">
            <span class="vstat__k">${k}</span><span class="vstat__v">${v}</span></li>`).join('')}
        </ul>
      </div>

      <div class="saving${flat ? ' saving--flat' : ''}">
        <p class="saving__label">${flat ? 'Дешевле фуры вариантов нет' : 'Экономия против выделенной фуры'}</p>
        <p class="saving__value" id="saving-value">${fmt.kzt(Math.max(0, sol.savingKzt))}</p>
        ${flat ? '' : `<div class="saving__chips">
          <span class="badge badge--good">−${costCut} % к цене</span>
          <span class="badge badge--good">−${co2Cut} % выбросов</span>
        </div>`}
      </div>
    </div>

    ${routeStrip(rec)}

    ${noneFeasible ? `<p class="warnline">Ни один вариант не укладывается в
      ${fmt.hoursShort(req.deadlineH)}. Показан лучший из непроходящих — увеличьте
      срок или разбейте партию.</p>` : ''}

    <div class="why" id="why">
      <h2 class="why__title">Почему так</h2>
      <p class="why__text">${esc(sol.explanation)}</p>
    </div>`;

  rollNumber(el('saving-value'), Math.max(0, sol.savingKzt), lastSaving, v => fmt.kzt(v));
  lastSaving = Math.max(0, sol.savingKzt);

  // Полный разбор приходит асинхронно: движок может ходить в сеть.
  // До его прихода в блоке уже стоит живой текст, а не заглушка.
  const token = ++explainToken;
  explainSolution(sol, req).then(res => {
    if (token !== explainToken) return;
    const box = el('why');
    if (!box || !res.paragraphs?.length) return;
    box.innerHTML = `<h2 class="why__title">Почему так</h2>` +
      res.paragraphs.map(p => `<p class="why__text">${p}</p>`).join('');
  }).catch(() => { /* остаётся текст движка — этого достаточно */ });
}

/** Лента маршрута: города — точками, плечи — линиями между ними. */
function routeStrip(route) {
  const legs = route.legs || [];
  if (!legs.length) return '';

  const stops = [legs[0].from, ...legs.map(l => l.to)];
  const transferAt = new Set(legs.filter(l => l.transshipment).map(l => l.from));
  const shipH = transshipHours(route);

  const parts = [];
  stops.forEach((id, i) => {
    const isEnd = i === 0 || i === stops.length - 1;
    const isTransfer = transferAt.has(id);
    parts.push(`<li class="route__node${isEnd ? ' route__node--end' : ''}${isTransfer ? ' route__node--transfer' : ''}">
      <span class="route__track"><i class="route__dot"></i></span>
      <span class="route__label">${nameOf(id)}
        ${isTransfer ? `<em class="route__badge">перегрузка ${fmt.hoursShort(shipH)}</em>` : ''}
      </span>
    </li>`);

    const leg = legs[i];
    if (leg) {
      parts.push(`<li class="route__link route__link--${leg.mode}">
        <span class="route__track"><i class="route__line"></i></span>
        <span class="route__meta"><b>${leg.mode === 'rail' ? 'Железная дорога' : 'Автотранспорт'}</b>
          ${fmt.km(leg.km)} · ${fmt.hoursShort(leg.hours)}</span>
      </li>`);
    }
  });

  return `<ol class="route" aria-label="Состав маршрута">${parts.join('')}</ol>`;
}

/**
 * Стоянку на перегрузку берём как разницу между итогом маршрута и суммой
 * плеч. Если движок уже зашил её внутрь leg.hours, разница будет нулевой —
 * тогда показываем константу, но строки всё равно сойдутся с итогом.
 */
function transshipHours(route) {
  const legSum = route.legs.reduce((s, l) => s + l.hours, 0);
  const count = route.legs.filter(l => l.transshipment).length || 1;
  const diff = (route.hours - legSum) / count;
  return diff > 0.05 ? diff : engine.CONSTANTS.TRANSSHIP_H;
}

function renderNetworkMeta() {
  const net = engine.getNetwork();
  const shown = state.hovered || state.solution.recommended;
  el('network-meta').textContent = `${net.nodes.length} городов`;
  el('network-sub').textContent = state.hovered
    ? 'Маршрут точки под курсором'
    : 'Маршрут из рекомендации';
  el('network-note').innerHTML = shown
    ? `Сейчас показан <b>«${esc(shown.label)}»</b> — ${fmt.km(shown.km ?? legKm(shown))},
       ${fmt.hoursShort(shown.hours)}. Сплошная линия — железная дорога, штриховая — автодорога.`
    : 'Сплошная линия — железная дорога, штриховая — автодорога.';
}

const legKm = r => r.legs.reduce((s, l) => s + l.km, 0);

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

/** Число не подменяется, а доезжает: видно, что оно поменялось. */
function rollNumber(node, target, from, format) {
  if (!node) return;
  node.textContent = format(target);   // итог сразу: если кадры не идут,
                                       // на экране всё равно верное число
  if (REDUCED || Math.abs(target - from) < 1) return;

  const t0 = performance.now();
  const dur = 420;
  const tick = now => {
    const k = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    node.textContent = format(from + (target - from) * e);
    if (k < 1 && node.isConnected) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
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
applyView();
renderModelNote();
