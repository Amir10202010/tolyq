// =====================================================================
//  TOLYQ — ОРКЕСТРАЦИЯ. ПУБЛИЧНЫЙ API ДВИЖКА
// ---------------------------------------------------------------------
//  Единственный модуль, который импортирует UI. Всё остальное — внутренности.
//
//  ДВА ПРОХОДА ПО ФРОНТУ, и это существенно.
//  Цена железнодорожного варианта зависит от того, насколько удастся
//  набрать вагон, а это знает только MDP из stopping.js. Поэтому:
//    1. строим фронт по консервативной расчётной загрузке;
//    2. решаем MDP на лучшем железнодорожном варианте — он даёт
//       ОЖИДАЕМУЮ загрузку и вероятность её достичь;
//    3. пересчитываем фронт по этой загрузке и выбираем из него.
//  Иначе пользователю показывалась бы цена при загрузке, которую
//  политика не обещает набрать.
//
//  Упаковка пока отдаётся в вырожденной честной форме — в вагоне только
//  наш груз. Слой 3 заменит её отжигом по потоку из market.js.
// =====================================================================

import { paretoRoutes, pickByWeights, wagonShare, wagonsNeeded } from './pareto.js';
import { computeStopping } from './stopping.js';
import { packing } from './packing.js';
import { simulateArrivals, trainOnSimulatedHistory, getModelInfo } from './market.js';
import { truckCo2Kg, railCo2Kg, trucksNeeded } from './co2.js';
import {
  getNetwork,
  WAGON_CAP_T,
  M3_PER_TON,
  m3PerTon,
  assumedWagonFillT,
  effectiveWagonCapacityT,
} from './network.js';

// ---------------------------------------------------------------------
//  ПУБЛИЧНЫЙ API ЦЕЛИКОМ — ровно то, что перечислено в types.js.
//  Интерфейс импортирует только отсюда и о внутренних модулях не знает,
//  поэтому реэкспорт обязателен: без него UI получил бы undefined.
// ---------------------------------------------------------------------
export { getNetwork } from './network.js';
export { simulateArrivals } from './market.js';
export { computeStopping } from './stopping.js';

// ---------------------------------------------------------------------
//  НОРМАЛИЗАЦИЯ ЗАЯВКИ
// ---------------------------------------------------------------------

/**
 * Приводит вход от UI к внутреннему виду и подставляет разумные умолчания.
 * UI — источник недоверенных данных: ползунки, поля ввода, чужие моки.
 * Всё, что пришло оттуда, здесь зажимается в допустимые границы.
 */
function normalizeRequest(raw = {}) {
  const tons = clamp(num(raw.tons, 8), 0, 5000);
  const cargoType = ['food', 'general', 'chemical'].includes(raw.cargoType)
    ? raw.cargoType
    : 'general';
  // Если объём не задан — оцениваем по плотности ЭТОГО типа груза:
  // 8 т муки и 8 т генгруза в таре занимают разный объём.
  const volumeM3 = clamp(num(raw.volumeM3, tons * m3PerTon(cargoType)), 0, 40000);

  return {
    from: String(raw.from || 'AST'),
    to: String(raw.to || 'ALA'),
    tons,
    volumeM3,
    cargoType,
    deadlineH: clamp(num(raw.deadlineH, 96), 1, 24 * 60),
    weights: {
      cost: clamp(num(raw.weights?.cost, 1 / 3), 0, 1),
      time: clamp(num(raw.weights?.time, 1 / 3), 0, 1),
      co2: clamp(num(raw.weights?.co2, 1 / 3), 0, 1),
    },
    // Расчётная загрузка вагона — доля ФАКТИЧЕСКОЙ вместимости для этой
    // партии, а не паспортных 68 т: лёгкий груз закубатуривает вагон раньше.
    assumedWagonFillT: clamp(
      num(raw.assumedWagonFillT, assumedWagonFillT(tons, volumeM3)),
      1,
      WAGON_CAP_T
    ),
    seed: raw.seed ?? 'tolyq',
  };
}

const num = (v, def) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ---------------------------------------------------------------------
//  БАЗА СРАВНЕНИЯ: «КАК ВОЗЯТ СЕГОДНЯ»
// ---------------------------------------------------------------------

/**
 * Автомобильный вариант — то, что отправитель делает по умолчанию:
 * берёт фуру и едет. Самый дешёвый чисто автомобильный маршрут.
 * Может отсутствовать: к Достыку автодороги нет.
 */
function findTruckBaseline(all) {
  const roadOnly = all.filter((r) => r.legs.length > 0 && r.legs.every((l) => l.mode === 'road'));
  if (roadOnly.length === 0) return null;
  return roadOnly.reduce((a, b) => (a.costKzt <= b.costKzt ? a : b));
}

// ---------------------------------------------------------------------
//  ОБЪЯСНЕНИЕ ПО-РУССКИ
// ---------------------------------------------------------------------

const fmtKzt = (v) => Math.round(v).toLocaleString('ru-RU') + ' ₸';
const fmtH = (h) => {
  const d = Math.floor(h / 24);
  const r = Math.round(h % 24);
  return d > 0 ? `${d} сут ${r} ч` : `${Math.round(h)} ч`;
};
const fmtKg = (v) => `${Math.round(v)} кг`;

/**
 * Собирает человеческую фразу из чисел. Никаких оценочных прилагательных,
 * которые не подкреплены расчётом: каждое утверждение — из результата.
 */
function buildExplanation({ req, rec, baseline, savingKzt, savingCo2Kg, stopping }) {
  if (!rec) {
    return `Маршрут ${req.from} → ${req.to} не найден: узлы не связаны в сети. Проверьте пункты отправления и назначения.`;
  }

  const parts = [];
  parts.push(
    `Партия ${round1(req.tons)} т, ${req.from} → ${req.to}. Рекомендуем: ${rec.label} — ${fmtKzt(rec.costKzt)}, ${fmtH(rec.hours)}, ${fmtKg(rec.co2Kg)} CO₂.`
  );

  if (!rec.feasible) {
    parts.push(
      `Внимание: в дедлайн ${fmtH(req.deadlineH)} не укладывается ни один вариант — быстрейший идёт ${fmtH(rec.hours)}. Показываем ближайшее возможное.`
    );
  }

  if (baseline && baseline.id !== rec.id) {
    const pct = baseline.costKzt > 0 ? Math.round((savingKzt / baseline.costKzt) * 100) : 0;
    if (savingKzt > 0) {
      parts.push(
        `Против привычной фуры (${fmtKzt(baseline.costKzt)}, ${fmtH(baseline.hours)}) экономия ${fmtKzt(savingKzt)} — это ${pct}% — и ${fmtKg(savingCo2Kg)} CO₂.`
      );
    } else {
      parts.push(
        `Фура обошлась бы в ${fmtKzt(baseline.costKzt)} за ${fmtH(baseline.hours)}: по деньгам она здесь не хуже, выигрыш только по срокам.`
      );
    }
  }

  const hasRail = rec.legs.some((l) => l.mode === 'rail');
  if (hasRail && wagonsNeeded(req.tons, req.volumeM3) === 1) {
    const capT = effectiveWagonCapacityT(req.tons, req.volumeM3);
    parts.push(
      `Цена посчитана как доля вагона при загрузке ${round1(req.assumedWagonFillT)} т — вагон для такого груза вмещает ${round1(capT)} т. В одиночку тот же вагон стоил бы ${fmtKzt(rec.costSoloKzt)}.`
    );
  }

  if (hasRail && stopping && !stopping.degenerate && stopping.horizonH > 0) {
    parts.push(
      `Отправлять выгоднее на ${stopping.dispatchAtH}-м часу: до него ждём попутный груз, дальше ожидание дороже выигрыша. Вероятность уехать вагоном, а не фурой, — ${Math.round(stopping.probability * 100)}%.`
    );
  }

  return parts.join(' ');
}

const round1 = (x) => Math.round(x * 10) / 10;

// ---------------------------------------------------------------------
//  УПАКОВКА ВАГОНА НА СМОДЕЛИРОВАННОМ ПОТОКЕ
// ---------------------------------------------------------------------

/**
 * Кого удалось бы взять в вагон за время ожидания.
 *
 * Поток берём ровно на горизонте политики: показывать заявки, которые
 * придут уже после рекомендованной отправки, было бы враньём — мы их
 * не увидим. Если политика вырождена, ждать нечего и попутки нет.
 */
function packForRequest(req, stopping) {
  const horizon = stopping && !stopping.degenerate ? stopping.horizonH : 0;
  if (horizon <= 0) {
    return packing([], { tons: req.tons, volumeM3: req.volumeM3, cargoType: req.cargoType }, req.seed);
  }

  const arrivals = simulateArrivals(req, horizon, `${req.seed}:pack`);
  return packing(
    arrivals,
    { tons: req.tons, volumeM3: req.volumeM3, cargoType: req.cargoType },
    `${req.seed}:anneal`
  );
}

// ---------------------------------------------------------------------
//  ГЛАВНАЯ ФУНКЦИЯ
// ---------------------------------------------------------------------

/**
 * Полное решение по заявке.
 * @param {Object} rawRequest ShipmentRequest из types.js
 * @returns {Object} Solution из types.js
 */
export function solve(rawRequest) {
  const req = normalizeRequest(rawRequest);

  // ПРОХОД 1: фронт по консервативной расчётной загрузке вагона.
  const first = paretoRoutes(req.from, req.to, req);

  // Сеть не связывает эти узлы — отдаём валидный пустой ответ, не бросаем.
  if (first.pareto.length === 0) {
    return {
      pareto: [],
      dominated: [],
      truckBaseline: null,
      recommended: null,
      stopping: computeStopping(req, req.seed),
      packing: packForRequest(req, null),
      savingKzt: 0,
      savingCo2Kg: 0,
      explanation: buildExplanation({ req, rec: null }),
      request: req,
      stats: first.stats,
    };
  }

  const allFirst = first.pareto.concat(first.dominated);

  // Лучший железнодорожный вариант — на нём и решаем задачу об остановке.
  const railRoutes = allFirst.filter(
    (r) => r.legs.length > 0 && r.legs.every((l) => l.mode === 'rail')
  );
  const bestRail = railRoutes.length
    ? railRoutes.reduce((a, b) => (a.costSoloKzt <= b.costSoloKzt ? a : b))
    : null;
  const truckFirst = findTruckBaseline(allFirst);

  // ПРОХОД 2 (MDP): когда отправлять и какая загрузка ожидается.
  const stopping = computeStopping(req, req.seed, {
    railWagonCostKzt: bestRail ? bestRail.costSoloKzt : undefined,
    railHours: bestRail ? bestRail.hours : undefined,
    truckCostKzt: truckFirst ? truckFirst.costKzt : undefined,
  });

  // ПРОХОД 3: пересчёт фронта по ОЖИДАЕМОЙ загрузке из политики.
  // Если политика вырождена (ждать негде или незачем) — оставляем
  // первый проход: пересчитывать не по чему.
  const useFill = !stopping.degenerate && stopping.expectedFillT > 0;
  const finalReq = useFill
    ? { ...req, assumedWagonFillT: clamp(stopping.expectedFillT, 1, WAGON_CAP_T) }
    : req;
  const { pareto, dominated, stats } = useFill
    ? paretoRoutes(req.from, req.to, finalReq)
    : first;

  const truckBaseline = findTruckBaseline(pareto.concat(dominated));

  // Выбираем из укладывающихся в дедлайн; если таких нет — из всего фронта,
  // но флаг feasible остаётся false и объяснение об этом скажет.
  const feasible = pareto.filter((r) => r.feasible);
  const recommended = pickByWeights(feasible.length ? feasible : pareto, req.weights);

  const savingKzt = truckBaseline ? truckBaseline.costKzt - recommended.costKzt : 0;
  const savingCo2Kg = truckBaseline
    ? Math.round((truckBaseline.co2Kg - recommended.co2Kg) * 10) / 10
    : 0;

  return {
    pareto,
    dominated,
    truckBaseline,
    recommended,
    stopping,
    packing: packForRequest(finalReq, stopping),
    savingKzt,
    savingCo2Kg,
    explanation: buildExplanation({
      req: finalReq,
      rec: recommended,
      baseline: truckBaseline,
      savingKzt,
      savingCo2Kg,
      stopping,
    }),
    request: finalReq, // нормализованная заявка — UI полезно видеть, что считали
    stats,
  };
}

// =====================================================================
//  ПРОГОН МЕСЯЦА ПО КОРИДОРУ
// ---------------------------------------------------------------------
//  Что было бы, если бы политику применяли ВСЕ отправители на плече,
//  а не один. Это ответ на вопрос «а какой эффект в масштабе».
//
//  Считаем честно, по непрерывному потоку и по найденной политике:
//    БЕЗ TOLYQ — каждый отправитель берёт свою фуру (или несколько,
//                если партия не влезает). Так возят сегодня.
//    С TOLYQ   — заявки копятся, и в КАЖДЫЙ час политика решает,
//                отправлять вагон или ждать ещё; что поедет из
//                накопленного, выбирает отжиг.
//  Разница по машинам, деньгам и выбросам — и есть эффект.
//
//  Никаких коэффициентов «внедрение даёт 30 % экономии»: всё, что
//  показывается, получено этим прогоном.
// =====================================================================

/**
 * Прогон месяца с ПРИМЕНЕНИЕМ ПОЛИТИКИ.
 *
 * Политику считаем один раз для коридора, дальше идём по непрерывному
 * потоку заявок час за часом и в каждый час спрашиваем у неё то же самое,
 * что спросил бы отдельный отправитель: отправлять накопленное или ждать.
 * Это принципиально отличается от «сгруппировать заявки суток пачкой»:
 * там консолидация происходит по календарю, а не по решению — и весь
 * смысл задачи об остановке из прогона исчезает.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {number|string} [seed]
 * @param {Object} [opts] { days }
 * @returns {Object} MonthSummary по контракту
 */
export function runMonth(fromId, toId, seed = 'tolyq', opts = {}) {
  const days = Math.max(1, Math.min(365, opts.days ?? 30));
  const probe = {
    from: fromId, to: toId, tons: 8, volumeM3: 8 * M3_PER_TON,
    cargoType: 'general', deadlineH: 240, seed,
  };

  // Параметры плеча берём из фронта: те же цифры, что видит пользователь.
  const { pareto, dominated } = paretoRoutes(fromId, toId, probe);
  const all = pareto.concat(dominated);
  const rail = pickCheapest(all.filter((r) => r.legs.length && r.legs.every((l) => l.mode === 'rail')), 'costSoloKzt');
  const road = pickCheapest(all.filter((r) => r.legs.length && r.legs.every((l) => l.mode === 'road')), 'costKzt');

  const empty = {
    shipments: 0, trucksAvoided: 0, co2SavedKg: 0, kztSaved: 0,
    avgFillPct: 0, dailyTrucksAvoided: new Array(days).fill(0),
    days, corridor: `${fromId}-${toId}`, wagons: 0, dispatchHours: [],
  };
  // Нет железнодорожного варианта — консолидировать не во что.
  if (!rail) return empty;

  const railKm = rail.legs.reduce((s, l) => s + l.km, 0);
  const wagonCost = rail.costSoloKzt;
  // Автомобильная альтернатива на том же плече; без дорог сравнивать не с чем.
  const truckKm = road ? road.legs.reduce((s, l) => s + l.km, 0) : 0;
  const truckCost = road ? road.costKzt / trucksNeeded(probe.tons, probe.volumeM3) : 0;

  // ПОЛИТИКА. Считается один раз: плечо и распределение прихода за месяц
  // не меняются, а пересчитывать её на каждый вагон — 30 лишних решений MDP.
  const policy = computeStopping(probe, `${seed}:policy`, {
    railWagonCostKzt: wagonCost,
    railHours: rail.hours,
    truckCostKzt: road ? road.costKzt : undefined,
    mcRuns: 0, // вероятность здесь не нужна, только пороги
  });
  const horizon = policy.degenerate ? 0 : policy.horizonH;
  const thresholds = policy.thresholdByHour;

  const totalH = days * 24;
  const arrivals = simulateArrivals(probe, totalH, `${seed}:month`);

  let shipments = arrivals.length;
  let trucksAvoided = 0;
  let co2Saved = 0;
  let kztSaved = 0;
  let fillSum = 0;
  let wagons = 0;
  const dailyTrucksAvoided = new Array(days).fill(0);
  const dispatchHours = [];

  // Заявки, ждущие своего вагона. Открытый вагон — те, что уже накоплены.
  let pending = [];
  let openedAtH = null;
  let idx = 0;

  /**
   * Отправка: из накопленного отжигом выбираем, что реально поедет,
   * остальное возвращается в очередь и ждёт следующего вагона.
   */
  const dispatch = (atH) => {
    if (pending.length === 0) return;

    const res = packing(pending, null, `${seed}:w${wagons}`);
    const goes = res.accepted;

    // Вагон с одной заявкой — тот же одиночный рейс, только по ЖД:
    // экономии от консолидации нет, и записывать её в эффект нельзя.
    if (goes.length < 2) {
      const a = pending[0];
      const n = trucksNeeded(a.tons, a.volumeM3);
      pending = pending.slice(1);
      openedAtH = pending.length ? openedAtH : null;
      // Уехал фурой — ни экономии, ни потерь относительно «как сегодня»
      void n;
      return;
    }

    const tons = goes.reduce((s, a) => s + a.tons, 0);

    // Как было бы без TOLYQ: каждому своя машина.
    let trucksBefore = 0;
    let co2Before = 0;
    let kztBefore = 0;
    for (const a of goes) {
      const n = trucksNeeded(a.tons, a.volumeM3);
      trucksBefore += n;
      co2Before += truckCo2Kg(truckKm, a.tons, a.volumeM3);
      kztBefore += truckCost * n;
    }

    trucksAvoided += trucksBefore;
    co2Saved += co2Before - railCo2Kg(railKm, tons);
    kztSaved += kztBefore - wagonCost;
    fillSum += res.fillPct;
    wagons++;
    dispatchHours.push(Math.round(atH));

    const day = Math.min(days - 1, Math.floor(atH / 24));
    dailyTrucksAvoided[day] += trucksBefore;

    const taken = new Set(goes.map((a) => `${a.shipper}|${a.atH}`));
    pending = pending.filter((a) => !taken.has(`${a.shipper}|${a.atH}`));
    openedAtH = pending.length ? openedAtH : null;
  };

  for (let t = 0; t <= totalH; t++) {
    while (idx < arrivals.length && arrivals[idx].atH <= t) {
      const a = arrivals[idx++];
      if (pending.length === 0) openedAtH = t;
      pending.push(a);
    }
    if (pending.length === 0) continue;

    // Тот же вопрос, что задаёт себе отдельный отправитель, и тот же
    // ответ: сравниваем накопленное с порогом ЭТОГО часа ожидания.
    const waited = t - openedAtH;
    const tons = pending.reduce((s, a) => s + a.tons, 0);
    const qState = Math.round(tons / 2) * 2;

    const forced = horizon <= 0 || waited >= horizon || t >= totalH;
    const threshold = thresholds[Math.min(waited, thresholds.length - 1)];

    if (forced || qState >= threshold) dispatch(t);
  }

  return {
    shipments,
    trucksAvoided,
    co2SavedKg: Math.round(co2Saved),
    kztSaved: Math.round(kztSaved),
    avgFillPct: wagons > 0 ? Math.round((fillSum / wagons) * 10) / 10 : 0,
    dailyTrucksAvoided,
    days,
    corridor: `${fromId}-${toId}`,
    wagons,
    // Диагностика: в какие часы политика отправляла вагоны
    dispatchHours,
    policyHorizonH: horizon,
  };
}

/** Самый дешёвый маршрут списка по указанному полю; null для пустого. */
function pickCheapest(routes, key) {
  if (!routes || routes.length === 0) return null;
  return routes.reduce((a, b) => (a[key] <= b[key] ? a : b));
}

// ---------------------------------------------------------------------
//  ОБУЧАЕМАЯ МОДЕЛЬ ИНТЕНСИВНОСТИ — ДЛЯ ИНТЕРФЕЙСА
// ---------------------------------------------------------------------

/** Плечи, на которых обучаемся: магистраль, юг, запад и границы. */
const TRAINING_CORRIDORS = [
  ['AST', 'KGF'], ['KGF', 'ALA'], ['AST', 'PWQ'], ['AST', 'KSN'],
  ['AKX', 'ATX'], ['ATX', 'SCO'], ['SHY', 'DMB'], ['DMB', 'ALA'],
  ['ALA', 'KHG'], ['ALA', 'DOS'],
];

let cachedModel = null;

/**
 * Обучает модель интенсивности на сгенерированной истории.
 * Результат кэшируется: обучение занимает десятки миллисекунд, а UI
 * может спросить сводку на каждой перерисовке.
 *
 * @param {Object} [opts] { weeks, seed, force }
 */
export function getIntensityModel(opts = {}) {
  if (cachedModel && !opts.force) return cachedModel;
  cachedModel = trainOnSimulatedHistory(TRAINING_CORRIDORS, opts.weeks ?? 4, opts.seed ?? 'tolyq-train');
  return cachedModel;
}

/** Сводка об обученной модели для интерфейса: наблюдения, плечи, правдоподобие. */
export function modelInfo(opts = {}) {
  return getModelInfo(getIntensityModel(opts));
}
