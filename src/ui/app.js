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

import * as engine from './engine.js';
import { NODES } from '../core/types.js';
import * as fmt from './format.js';
import { createForm } from './form.js';
import { createPareto, registerNames } from './pareto.js';
import { createNetworkMap } from './network-map.js';
import { createLoadbar } from './loadbar.js';
import { createStopping } from './stopping.js';
import { createSummary } from './summary.js';
import { createTable } from './table.js';
import { explainSolution, getModelInfo } from './explain.js';
import { toast } from './toast.js';

registerNames(NODES);

// ---------------------------------------------------------------------
//  Демо-сценарий. На защите руками не вводится ничего.
//
//  СРОК 72 ч, а не 48, как было в исходном задании. Причина фактическая:
//  движок считает ход Астана — Алматы по железной дороге за 42,7 ч, и при
//  сроке 48 ч на ожидание попутного груза остаётся пять часов. Тогда
//  вторая половина продукта — «когда отправлять» — показать нечего:
//  порог не пересекается, ни одна заявка не отскакивает, анимация идёт
//  четыре секунды. При 72 ч горизонт 29 ч, отправка на 6-м часе, четыре
//  отказа с причинами и загрузка 69 %.
//  Вернуть прежнее поведение — заменить 72 на 48 здесь и в index.html.
// ---------------------------------------------------------------------
const DEMO_REQUEST = {
  from: 'AST', to: 'ALA',
  tons: 8, volumeM3: 52,
  cargoType: 'food',
  deadlineH: 72,
  weights: { cost: 0.5, time: 0.3, co2: 0.2 },
};

const state = {
  request: { ...DEMO_REQUEST },
  solution: null,
  month: null,
  demo: null,             // производные данные сцены сборки вагона
  hovered: null,          // маршрут под курсором: связка Парето ↔ карта
  picked: null,           // закреплённый щелчком: переживает уход курсора
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
  onPick:  route => setPicked(route),
});

const map = createNetworkMap(el('network-chart'));

const table = createTable(el('options-table'), {
  onHover: route => setHovered(route),
  onPick:  route => setPicked(route),
});

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
//  ПРЕДСТАВЛЕНИЕ ВАРИАНТОВ
//  График показывает форму компромисса, таблица — точные числа и
//  сортировку. Логисту нужно и то и другое, поэтому это переключатель,
//  а не выбор за него.
// ---------------------------------------------------------------------
let optionsMode = 'chart';

for (const btn of el('options-switch').querySelectorAll('.switch__btn')) {
  btn.addEventListener('click', () => setOptionsMode(btn.dataset.mode));
}

function setOptionsMode(mode) {
  optionsMode = mode;
  el('options-chart').hidden = mode !== 'chart';
  el('options-table').hidden = mode !== 'table';
  document.querySelector('.panel--options').classList.toggle('is-wide', mode === 'table');
  for (const b of el('options-switch').querySelectorAll('.switch__btn')) {
    b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  }
  // Инструкции под графиком больше нет: оси подписаны, легенда рядом,
  // а двадцать слов мелким шрифтом человек всё равно не читал.
  if (mode === 'chart') pareto.update(state.solution, state.request);
  else table.update(state.solution, state.request);
  renderPicks();
  syncRoute();
}

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
  for (const a of document.querySelectorAll('.nav__item')) {
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
    renderOptions();
    map.update(engine.getNetwork(), state.request);
    map.showRoute(shownRoute());
  } else if (v === 'timing') {
    loadbar.refresh();
    stopping.refresh();
  } else if (v === 'impact') {
    summary.update(state.month);
  }
}

window.addEventListener('hashchange', applyView);

// ---------------------------------------------------------------------
//  ЗАЯВКА
//  Форма свёрнута на любой ширине, а не только на телефоне. Открывший
//  продукт впервые должен увидеть ответ, а не четырнадцать полей ввода;
//  кто пришёл править заявку — жмёт «Изменить» и получает их все сразу.
// ---------------------------------------------------------------------
const aside = el('aside');
const asideToggle = el('aside-toggle');

function setAsideOpen(open) {
  aside.classList.toggle('is-open', open);
  asideToggle.setAttribute('aria-expanded', String(open));
  asideToggle.textContent = open ? 'Свернуть' : 'Изменить';
}

asideToggle.addEventListener('click', () => {
  setAsideOpen(!aside.classList.contains('is-open'));
});

// «Посчитать свою заявку» с последнего шага — это та же форма. Отдельного
// экрана она не заслуживает, поэтому просто открываем её и подводим фокус.
el('try-own')?.addEventListener('click', () => {
  setAsideOpen(true);
  aside.scrollIntoView({ block: 'start', behavior: REDUCED ? 'auto' : 'smooth' });
  el('f-free').focus({ preventScroll: true });
});

// ---------------------------------------------------------------------
//  Пересчёт
// ---------------------------------------------------------------------
let solveSeq = 0;

/**
 * Пересчёт терпит и синхронный ответ движка, и обещание. Моки отвечают
 * мгновенно, настоящий движок может считать заметно дольше — тогда на
 * это время показывается состояние ожидания, а не пустой экран.
 */
function recompute(request) {
  state.request = request;
  state.hovered = null;   // маршруты пересобрались, старые ссылки протухли
  state.picked = null;

  el('aside-summary').textContent = [
    `${fmt.tons(request.tons, request.tons % 1 ? 1 : 0)} ${engine.CARGO_TYPES[request.cargoType].toLowerCase()}`,
    `${nameOf(request.from)} → ${nameOf(request.to)}`,
    fmt.hoursShort(request.deadlineH),
  ].join(' · ');

  const seq = ++solveSeq;
  let answer;
  try {
    answer = engine.solve(request);
  } catch (err) {
    showFailure(err);
    return;
  }

  if (answer && typeof answer.then === 'function') {
    setBusy(true);
    answer.then(sol => {
      if (seq !== solveSeq) return;      // пока считали, заявку поменяли
      setBusy(false);
      apply(sol);
    }).catch(err => {
      if (seq !== solveSeq) return;
      setBusy(false);
      showFailure(err);
    });
    return;
  }

  apply(answer);

  function apply(sol) {
    if (!sol || !sol.recommended) { showFailure(new Error('движок не вернул решение')); return; }

    state.solution = sol;
    state.month = engine.runMonth(request.from, request.to);
    state.demo = buildDemo(sol, request);

    renderVerdict();
    renderOptions();

    map.update(engine.getNetwork(), state.request);
    map.showRoute(sol.recommended);
    renderNetworkMeta();

    const ctx = { request, solution: sol, demo: state.demo };
    loadbar.update(ctx);
    stopping.update(ctx);
    summary.update(state.month);

    // «Неулучшаемый» — слово из теории Парето, а не из речи грузоотправителя.
    const considered = sol.considered ?? (sol.pareto.length + sol.dominated.length);
    // «Из чего стоит выбирать» теперь говорит короткий список под графиком,
    // и подзаголовку осталась его собственная работа — прочесть оси.
    el('pareto-meta').textContent =
      `Перебрали ${considered} ${fmt.plural(considered, 'вариант', 'варианта', 'вариантов')}. ` +
      `По горизонтали срок, по вертикали деньги`;
    el('loadbar-meta').textContent = `вагон ${fmt.tons(state.demo.capacityTons)}`;
    el('stopping-meta').textContent = `горизонт ${fmt.hoursShort(state.demo.horizonH)}`;
    el('month-meta').textContent = `загрузка ${fmt.pct(state.month.avgFillPct)}`;

    clockReset();
  }
}

/** Оба представления вариантов кормятся из одного решения. */
function renderOptions() {
  if (optionsMode === 'chart') pareto.update(state.solution, state.request);
  else table.update(state.solution, state.request);
  renderPicks();
}

// ---------------------------------------------------------------------
//  КОРОТКИЙ СПИСОК
//  График отвечает на вопрос «какой тут вообще компромисс», а короткий
//  список — на вопрос «так что мне брать». Второй вопрос люди задают
//  чаще, поэтому ответ на него не должен требовать попадания курсором в
//  точку диаметром девять пикселей.
//
//  Строк ровно три. Четвёртая уже не выбор, а таблица, — а таблица в
//  этом разделе есть, и она на расстоянии одного переключателя.
// ---------------------------------------------------------------------
function renderPicks() {
  const box = el('options-picks');
  if (!box) return;

  const sol = state.solution;
  if (!sol || optionsMode !== 'chart') { box.innerHTML = ''; return; }

  // Считаем по тем, что укладываются в срок. Не уложился никто — берём
  // весь фронт: пустой список хуже честного «вот лучшее из непроходящих».
  const feasible = sol.pareto.filter(r => r.feasible);
  const pool = feasible.length ? feasible : sol.pareto;
  const bestBy = key => pool.reduce((a, b) => (b[key] < a[key] ? b : a), pool[0]);

  const wanted = pool.length ? [
    ['наш выбор',     sol.recommended],
    ['дешевле всего', bestBy('costKzt')],
    ['быстрее всего', bestBy('hours')],
    ['чище всего',    bestBy('co2Kg')],
  ] : [];

  // Один и тот же маршрут часто и рекомендован, и самый дешёвый. Тогда
  // это одна строка с двумя метками, а не две строки об одном и том же.
  const byId = new Map();
  for (const [tag, r] of wanted) {
    if (!r) continue;
    if (!byId.has(r.id)) byId.set(r.id, { route: r, tags: [] });
    byId.get(r.id).tags.push(tag);
  }
  const picks = [...byId.values()].slice(0, 3);
  if (!picks.length) { box.innerHTML = ''; return; }

  box.innerHTML = `
    <div class="picks__head">
      <p class="micro">Короткий список</p>
      <p class="picks__hint">Нажмите — покажем на карте</p>
    </div>
    ${picks.map(({ route: r, tags }) => `
      <button class="pick" type="button" data-id="${esc(r.id)}" aria-pressed="false">
        <span class="pick__tag">${tags.join(' · ')}</span>
        <span class="pick__name">${esc(r.label)}</span>
        <span class="pick__nums">
          <b>${fmt.kzt(r.costKzt, { short: true })}</b>
          <span>${fmt.hoursShort(r.hours)}</span>
          <span>${fmt.co2(r.co2Kg)}</span>
        </span>
      </button>`).join('')}`;

  for (const btn of box.querySelectorAll('.pick')) {
    const route = pool.find(r => r.id === btn.dataset.id) || sol.recommended;
    btn.addEventListener('click', () =>
      setPicked(state.picked?.id === route.id ? null : route));
    btn.addEventListener('pointerenter', () => setHovered(route));
    btn.addEventListener('pointerleave', () => setHovered(null));
    btn.addEventListener('focus', () => setHovered(route));
    btn.addEventListener('blur', () => setHovered(null));
  }

  markPicks();
}

/** Отметка «этот сейчас на карте». Отдельно от отрисовки: зовётся на каждое наведение. */
function markPicks() {
  const id = state.picked?.id;
  for (const btn of el('options-picks')?.querySelectorAll('.pick') || []) {
    btn.setAttribute('aria-pressed', String(btn.dataset.id === id));
    btn.classList.toggle('is-on', btn.dataset.id === id);
  }
}

/**
 * Движок считает. Прежний ответ не гасим — он ещё верен для прошлой
 * заявки, — но помечаем как несвежий, а разбор словами подменяем
 * скелетом: именно он пересобирается дольше всего.
 */
function setBusy(on) {
  const box = el('verdict');
  box.setAttribute('aria-busy', String(on));
  box.classList.toggle('is-stale', on);
  el('f-reset').classList.toggle('is-busy', on);

  const body = el('why')?.querySelector('.why__body');
  if (on && body) {
    body.innerHTML = `
      <div class="skeleton skeleton--line"></div>
      <div class="skeleton skeleton--line"></div>
      <div class="skeleton skeleton--line"></div>`;
  }
}

/** Движок упал. Интерфейс обязан объяснить это словами, а не белым экраном. */
function showFailure(err) {
  el('verdict').classList.remove('is-stale');
  el('verdict').classList.remove('verdict--compact');
  el('verdict').innerHTML = `
    <div class="empty empty--error">
      <span class="empty__ico">${ICON_ALERT}</span>
      <p class="empty__title">Не удалось рассчитать маршрут</p>
      <p class="empty__text">${esc(err?.message || 'Движок не ответил.')}
         Измените заявку или верните демо-сценарий.</p>
    </div>`;
  toast('Расчёт не прошёл', { text: err?.message || 'Движок не ответил', kind: 'bad' });
}

/**
 * Связка трёх представлений. Ради неё всё и затевалось: вариант под
 * курсором — хоть точка на графике, хоть строка таблицы, хоть строка
 * короткого списка — мгновенно показывает, каким путём по сети он
 * получен.
 *
 * Наведение сильнее закрепления, а закрепление сильнее рекомендации.
 * Иначе получалось так: человек нашёл интересный вариант, повёл глаза
 * на карту — и карта под ушедшим курсором вернулась к рекомендации.
 */
function setHovered(route) {
  state.hovered = route;
  syncRoute();
}

/** Щелчок по точке или по строке короткого списка. null — снять выбор. */
function setPicked(route) {
  state.picked = route;
  syncRoute();
}

function shownRoute() {
  if (!state.solution) return null;
  return state.hovered || state.picked || state.solution.recommended;
}

function syncRoute() {
  if (!state.solution) return;
  const live = state.hovered || state.picked;
  map.showRoute(shownRoute());
  renderNetworkMeta();
  // Своё представление подсвечивает себя само — синхронизируем соседей.
  if (optionsMode === 'chart') table.setHot(live ? live.id : null);
  else pareto.setHot(live ? live.id : null);
  const pinId = state.picked ? state.picked.id : null;
  pareto.setPin(pinId);
  table.setPin(pinId);
  markPicks();
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

  const co2Cut = base.co2Kg > 0 ? Math.round(sol.savingCo2Kg / base.co2Kg * 100) : 0;

  // Три числа, а не четыре. Загрузка вагона — величина для логиста, а не
  // для того, кто первый раз смотрит на ответ; она ушла в разбор ниже.
  const stats = [
    ['Цена',    fmt.kzt(rec.costKzt)],
    ['Срок',    fmt.hoursHuman(rec.hours)],
    ['Выбросы', fmt.co2(rec.co2Kg)],
  ];

  // Строки «что за груз» здесь больше нет: ровно те же слова стоят в
  // сводке заявки слева, а она теперь видна всегда. Повторять их под
  // заголовком — значит заставлять читать одно и то же дважды.

  el('verdict').classList.toggle('verdict--flat', flat);
  el('verdict').classList.remove('is-stale');
  // Ответ, экономия, числа, лента и разбор идут одной колонкой, разделённой
  // линейками. Коробок тут нет намеренно: решение — это и есть страница,
  // заворачивать её в карточку не во что.
  el('verdict').innerHTML = `
    <div class="verdict__head">
      <div class="verdict__answer">
        <p class="verdict__eyebrow">
          <i class="dot dot--${flat ? 'warn' : 'good'}" aria-hidden="true"></i>
          ${flat ? 'Лучшее из возможного' : 'Рекомендуем'}
        </p>
        <h1 class="verdict__title">${esc(rec.label)}</h1>
      </div>

      <div class="verdict__saving">
        <p class="micro">${flat ? 'Дешевле фуры вариантов нет' : 'Дешевле обычной фуры на'}</p>
        <p class="verdict__amount" id="saving-value">${fmt.kzt(Math.max(0, sol.savingKzt))}</p>
        ${flat ? '' : `<p class="verdict__deltas">
          <span class="delta delta--good">и на ${co2Cut} % меньше выбросов</span>
        </p>`}
      </div>
    </div>

    <div class="stats">
      ${stats.map(([k, v]) => `<div class="stat">
        <span class="stat__label">${k}</span>
        <span class="stat__value">${v}</span>
      </div>`).join('')}
    </div>

    ${routeStrip(rec)}

    ${noneFeasible ? `<p class="warnline">
      <span>Ни один вариант не укладывается в ${fmt.hoursShort(req.deadlineH)}.
      Показан лучший из непроходящих — увеличьте срок или разбейте партию.</span></p>` : ''}

    <details class="why" id="why">
      <summary class="why__title">Почему именно этот вариант</summary>
      <div class="why__body">
        <p class="why__text">${esc(sol.explanation)}</p>
      </div>
    </details>`;

  rollNumber(el('saving-value'), Math.max(0, sol.savingKzt), lastSaving, v => fmt.kzt(v));
  lastSaving = Math.max(0, sol.savingKzt);

  // Полный разбор приходит асинхронно: движок может ходить в сеть.
  // До его прихода в блоке уже стоит живой текст, а не заглушка.
  const token = ++explainToken;
  explainSolution(sol, req).then(res => {
    if (token !== explainToken) return;
    const body = el('why')?.querySelector('.why__body');
    if (!body || !res.paragraphs?.length) return;
    // Загрузка вагона живёт здесь: в разборе она объясняет цену, а строкой
    // метрик наверху была просто четвёртым числом без применения.
    body.innerHTML =
      res.paragraphs.map(p => `<p class="why__text">${p}</p>`).join('') +
      `<p class="why__aside">Вагон уходит заполненным на ${fmt.pct(rec.fillPct)}.</p>`;
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
  const shown = shownRoute();
  el('network-meta').textContent = `${net.nodes.length} городов`;
  // Подзаголовок отвечает на единственный вопрос: почему на карте
  // сейчас именно этот маршрут — я на него навёл, я его выбрал или это
  // рекомендация.
  el('network-sub').textContent = state.hovered ? 'Вариант под курсором'
    : state.picked ? 'Выбранный вариант'
    : 'Как поедет ваш груз';
  // Про начертание линий не пишем: об этом говорит легенда прямо над сноской.
  el('network-note').innerHTML = shown
    ? `<b>«${esc(shown.label)}»</b> — ${fmt.km(shown.km ?? legKm(shown))},
       ${fmt.hoursShort(shown.hours)}`
    : '';
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

/**
 * Вкладку свернули или экран погас — браузер перестаёт выдавать кадры, и
 * часы встают сами. Без этого обработчика кнопка продолжала бы врать
 * «Пауза», а при возврате сцена прыгнула бы вперёд на всё время отсутствия:
 * такт считается от реального времени, а не от числа кадров.
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden && clock.running) clockPause();
});

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

const ICON_ALERT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
  stroke-linecap="round"><path d="M12 8v5"/><path d="M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>`;

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
