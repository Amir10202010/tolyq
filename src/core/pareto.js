// =====================================================================
//  TOLYQ — МНОГОКРИТЕРИАЛЬНЫЙ ПОИСК МАРШРУТОВ
// ---------------------------------------------------------------------
//  Алгоритм Мартинса (label-correcting) по трём критериям одновременно:
//  стоимость, время, CO2. Одного «лучшего» маршрута не существует —
//  есть фронт Парето, и выбор точки на нём делает пользователь весами.
//
//  Почему не свёртка в один критерий заранее: взвешенная сумма способна
//  найти только вершины выпуклой оболочки фронта. Маршруты в «вогнутых»
//  участках — а это как раз интересные мультимодальные компромиссы —
//  не выбираются НИ ПРИ КАКИХ весах. Поэтому строим фронт честно,
//  а веса применяем уже к готовому фронту.
//
//  Состояние поиска — пара (узел, вид транспорта), а не просто узел:
//  прибытие в Караганду фурой и вагоном — разные состояния, у них
//  разное продолжение и разная стоимость смены режима.
// =====================================================================

import {
  edgesFrom,
  getNode,
  isHub,
  transshipment,
  TRUCK_CAP_T,
  TRUCK_CAP_M3,
  WAGON_CAP_T,
  WAGON_CAP_M3,
  MIN_WAGON_SHARE,
  MARKET_M3_PER_TON,
  assumedWagonFillT,
} from './network.js';
import { legCo2Kg, trucksNeeded, transshipCo2Kg } from './co2.js';

// ---------------------------------------------------------------------
//  ОГРАНИЧИТЕЛИ ВЗРЫВА МЕТОК
// ---------------------------------------------------------------------
/** Больше трёх перегрузок — не маршрут, а издевательство над грузом. */
export const MAX_TRANSSHIPMENTS = 3;
/** Потолок обработанных меток. Держит solve() в бюджете 300 мс. */
export const MAX_LABELS = 5000;
/**
 * Запас к дедлайну при отсечении. Отсекаем не по дедлайну ровно, а по
 * дедлайну × 1.5: маршруты, чуть-чуть не влезающие в срок, тоже нужно
 * показать — пользователю важно видеть, что он теряет из-за спешки.
 */
export const DEADLINE_SLACK = 1.5;

// ---------------------------------------------------------------------
//  СТОИМОСТЬ И ЗАГРУЗКА УЧАСТКА
// ---------------------------------------------------------------------

/**
 * Сколько вагонов физически нужно под партию (по массе и по объёму).
 * @returns {number} целое >= 1
 */
export function wagonsNeeded(tons, volumeM3 = 0) {
  const byMass = tons > 0 ? Math.ceil(tons / WAGON_CAP_T) : 0;
  const byVol = volumeM3 > 0 ? Math.ceil(volumeM3 / WAGON_CAP_M3) : 0;
  return Math.max(1, byMass, byVol);
}

/**
 * Доля вагона, которую отправитель оплачивает.
 *
 * Ключевая экономика проекта. Если партия помещается в один вагон,
 * отправитель платит не за вагон, а за свои тонны в общем вагоне —
 * при условии, что вагон удастся собрать (за это отвечает stopping.js).
 * Если партия больше вагона — консолидировать нечего, платим за целые вагоны.
 *
 * @param {number} tons
 * @param {number} volumeM3
 * @param {number} assumedFillT на какую загрузку вагона рассчитываем
 * @returns {number} множитель к тарифу за рейс вагона
 */
export function wagonShare(tons, volumeM3, assumedFillT = null) {
  const units = wagonsNeeded(tons, volumeM3);
  if (units > 1) return units; // свои вагоны, делить не с кем
  const target = assumedFillT ?? assumedWagonFillT(tons, volumeM3);
  const fill = Math.max(1, Math.min(target, WAGON_CAP_T));
  return Math.max(MIN_WAGON_SHARE, Math.min(1, tons / fill));
}

/** Стоимость проезда партии по одному ребру. */
function legCost(edge, ctx) {
  if (edge.mode === 'road') {
    return edge.kztPerTruckTrip * trucksNeeded(ctx.tons, ctx.volumeM3);
  }
  return edge.kztPerWagonTrip * ctx.share;
}

/**
 * Загрузка транспорта на участке, 0..1.
 * Берём максимум из массовой и объёмной — лимитирует та, что жёстче.
 * Для доли вагона показываем загрузку ВАГОНА (сколько он везёт всего),
 * а не долю отправителя: UI подписывает это как «загрузка транспорта».
 */
function legFill(mode, ctx) {
  if (mode === 'road') {
    const n = trucksNeeded(ctx.tons, ctx.volumeM3);
    return Math.max(ctx.tons / (TRUCK_CAP_T * n), ctx.volumeM3 / (TRUCK_CAP_M3 * n));
  }
  const units = wagonsNeeded(ctx.tons, ctx.volumeM3);
  if (units > 1) {
    return Math.max(ctx.tons / (WAGON_CAP_T * units), ctx.volumeM3 / (WAGON_CAP_M3 * units));
  }
  // Вагон считается загруженным по тому ресурсу, который кончился первым.
  // Лёгкий груз выбирает кубатуру задолго до тоннажа: 18 т при 6.5 м³/т
  // это 27 % по массе и 100 % по объёму, и честная цифра — вторая.
  const volAtFill = ctx.assumedFillT * MARKET_M3_PER_TON;
  return Math.min(1, Math.max(ctx.assumedFillT / WAGON_CAP_T, volAtFill / WAGON_CAP_M3));
}

// ---------------------------------------------------------------------
//  ДОМИНИРОВАНИЕ
// ---------------------------------------------------------------------

/** Погрешность сравнения: тенге и килограммы копим в double. */
const EPS = 1e-9;

/**
 * A доминирует B: не хуже по ВСЕМ критериям и строго лучше хотя бы по одному.
 *
 * Число перегрузок входит в сравнение четвёртым критерием — это ресурс:
 * метка с меньшим числом перегрузок имеет больше вариантов продолжения,
 * и выбрасывать её по трём критериям нельзя, иначе теряем корректные маршруты.
 *
 * @param {{cost:number,hours:number,co2:number,transship?:number}} a
 * @param {{cost:number,hours:number,co2:number,transship?:number}} b
 */
export function dominates(a, b) {
  const at = a.transship ?? 0;
  const bt = b.transship ?? 0;
  const noWorse =
    a.cost <= b.cost + EPS &&
    a.hours <= b.hours + EPS &&
    a.co2 <= b.co2 + EPS &&
    at <= bt;
  if (!noWorse) return false;
  return (
    a.cost < b.cost - EPS ||
    a.hours < b.hours - EPS ||
    a.co2 < b.co2 - EPS ||
    at < bt
  );
}

/**
 * Вставка метки во множество недоминируемых.
 * Возвращает false, если метку доминирует кто-то из уже лежащих.
 * Иначе вставляет и вычищает те, которые доминирует она сама.
 * @param {Array} set
 * @param {Object} label
 */
function insertNonDominated(set, label) {
  for (let i = 0; i < set.length; i++) {
    if (dominates(set[i], label)) return false;
  }
  // Обратный проход: удаляем поглощённые, не сбивая индексы.
  for (let i = set.length - 1; i >= 0; i--) {
    if (dominates(label, set[i])) set.splice(i, 1);
  }
  set.push(label);
  return true;
}

// ---------------------------------------------------------------------
//  ПОСТРОЕНИЕ МАРШРУТА ИЗ ЦЕПОЧКИ МЕТОК
// ---------------------------------------------------------------------

/**
 * Разворачивает метку в Route по контракту.
 * Метки хранят только ссылку на родителя и ребро — массив участков
 * материализуем один раз в конце, иначе на 5000 меток уходит память
 * на тысячи копий одних и тех же префиксов.
 */
function materialize(label, ctx) {
  const chain = [];
  for (let l = label; l && l.edge; l = l.parent) chain.push(l);
  chain.reverse();

  const legs = chain.map((l) => ({
    from: l.edge.from,
    to: l.edge.to,
    mode: l.edge.mode,
    km: l.edge.km,
    hours: l.edge.hours,
    costKzt: Math.round(l.legCost),
    co2Kg: Math.round(l.legCo2 * 10) / 10,
    transshipment: l.didTransship,
  }));

  const modes = new Set(legs.map((l) => l.mode));
  const multimodal = modes.size > 1;

  // Узлы, где менялся вид транспорта, — для человеческой подписи маршрута.
  const switchNodes = chain.filter((l) => l.didTransship).map((l) => getNode(l.edge.from)?.name || l.edge.from);

  let title;
  if (legs.length === 0) title = 'На месте';
  else if (!multimodal) title = modes.has('road') ? 'Только фура' : 'Только ЖД';
  else title = `Авто + ЖД через ${switchNodes.join(', ')}`;

  const fill = legs.length ? Math.min(...chain.map((l) => l.fill)) : 1;

  return {
    // Буквы режима — 'A' (авто) и 'R' (rail): mode[0] у road и rail совпадает,
    // и id автомобильного и железнодорожного маршрутов склеивались в один.
    id: `${chain[0]?.edge.from || ctx.from}-${legs.map((l) => (l.mode === 'road' ? 'A' : 'R') + l.to).join('-')}`,
    legs,
    costKzt: Math.round(label.cost),
    costSoloKzt: Math.round(label.costSolo), // цена, если везти вагон одному — доп. поле
    hours: Math.round(label.hours * 10) / 10,
    co2Kg: Math.round(label.co2 * 10) / 10,
    fillPct: Math.round(fill * 1000) / 10,
    multimodal,
    feasible: ctx.deadlineH == null || label.hours <= ctx.deadlineH + EPS,
    label: title,
    transshipments: label.transship,
  };
}

// ---------------------------------------------------------------------
//  ОСНОВНОЙ ПОИСК
// ---------------------------------------------------------------------

/**
 * Фронт Парето маршрутов из fromId в toId.
 *
 * @param {string} fromId
 * @param {string} toId
 * @param {Object} request заявка (tons, volumeM3, deadlineH, assumedWagonFillT)
 * @param {Object} [opts]
 * @param {boolean} [opts.ignoreDeadline] не отсекать по сроку (внутренний повтор)
 * @returns {{pareto: Array, dominated: Array, stats: Object}}
 */
export function paretoRoutes(fromId, toId, request = {}, opts = {}) {
  const tons = Math.max(0, request.tons || 0);
  const volumeM3 = Math.max(0, request.volumeM3 || 0);
  const assumedFillT = request.assumedWagonFillT || assumedWagonFillT(tons, volumeM3);
  const deadlineH = opts.ignoreDeadline ? null : request.deadlineH ?? null;

  const ctx = {
    from: fromId,
    tons,
    volumeM3,
    assumedFillT,
    deadlineH: request.deadlineH ?? null,
    share: wagonShare(tons, volumeM3, assumedFillT),
    shareSolo: wagonsNeeded(tons, volumeM3), // тот же груз без консолидации
  };

  const stats = { expanded: 0, generated: 0, prunedDeadline: 0, hitCap: false };

  // Вырожденные случаи: неизвестный узел, совпадение концов.
  if (!getNode(fromId) || !getNode(toId)) return { pareto: [], dominated: [], stats };
  if (fromId === toId) return { pareto: [], dominated: [], stats };

  const cutoff = deadlineH != null ? deadlineH * DEADLINE_SLACK : Infinity;

  /** Множества недоминируемых меток по состояниям «узел|режим». */
  const buckets = new Map();
  /** Всё, что было отброшено доминированием в целевом узле, — для серой отрисовки. */
  const dominatedAtTarget = [];

  const bucketOf = (node, mode) => {
    const key = `${node}|${mode}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    return b;
  };

  // Старт: режим ещё не выбран (mode = null), первая посадка на транспорт
  // перегрузкой не считается — груз и так надо погрузить.
  const start = {
    node: fromId,
    cost: 0,
    costSolo: 0,
    hours: 0,
    co2: 0,
    mode: null,
    transship: 0,
    parent: null,
    edge: null,
  };

  const queue = [start];

  while (queue.length > 0) {
    if (stats.expanded >= MAX_LABELS) {
      stats.hitCap = true;
      break;
    }
    const cur = queue.shift();
    stats.expanded++;

    // Метка могла быть вытеснена, пока лежала в очереди.
    if (cur.dead) continue;
    // Из целевого узла не разворачиваемся: маршрут закончен.
    if (cur.node === toId) continue;

    for (const edge of edgesFrom(cur.node)) {
      const switching = cur.mode !== null && cur.mode !== edge.mode;

      // Смена вида транспорта — только в хабе и не чаще MAX_TRANSSHIPMENTS.
      if (switching) {
        if (!isHub(cur.node)) continue;
        if (cur.transship + 1 > MAX_TRANSSHIPMENTS) continue;
      }

      // Не возвращаемся в узел, который уже посетили: циклы во фронте
      // никогда не полезны (все критерии строго растут), а меток жрут много.
      let revisits = false;
      for (let l = cur; l; l = l.parent) {
        if (l.node === edge.to) { revisits = true; break; }
      }
      if (revisits) continue;

      const tCost = switching ? transshipment.kztPerWagon * ctx.share : 0;
      const tCostSolo = switching ? transshipment.kztPerWagon * ctx.shareSolo : 0;
      const tHours = switching ? transshipment.hours : 0;
      const tCo2 = switching ? transshipCo2Kg(1) : 0;

      const lCost = legCost(edge, ctx);
      const lCostSolo =
        edge.mode === 'road' ? lCost : edge.kztPerWagonTrip * ctx.shareSolo;
      const lCo2 = legCo2Kg(edge.mode, edge.km, tons, volumeM3);

      const hours = cur.hours + tHours + edge.hours;

      // Раннее отсечение по сроку: с запасом, чтобы «почти успевающие»
      // варианты остались видимыми.
      if (hours > cutoff) {
        stats.prunedDeadline++;
        continue;
      }

      const label = {
        node: edge.to,
        cost: cur.cost + tCost + lCost,
        costSolo: cur.costSolo + tCostSolo + lCostSolo,
        hours,
        co2: cur.co2 + tCo2 + lCo2,
        mode: edge.mode,
        transship: cur.transship + (switching ? 1 : 0),
        parent: cur,
        edge,
        legCost: tCost + lCost,
        legCo2: tCo2 + lCo2,
        didTransship: switching,
        fill: legFill(edge.mode, ctx),
      };
      stats.generated++;

      const bucket = bucketOf(edge.to, edge.mode);

      // В целевом узле фиксируем вытесненные метки — это «честно перебранные»
      // варианты, UI рисует их серым.
      if (edge.to === toId) {
        const before = bucket.slice();
        if (!insertNonDominated(bucket, label)) {
          dominatedAtTarget.push(label);
          continue;
        }
        for (const old of before) {
          if (!bucket.includes(old)) {
            old.dead = true;
            dominatedAtTarget.push(old);
          }
        }
        // В целевой узел метку кладём, но не раскрываем — она в очередь не идёт.
        continue;
      }

      const before = bucket.slice();
      if (!insertNonDominated(bucket, label)) continue;
      for (const old of before) if (!bucket.includes(old)) old.dead = true;

      queue.push(label);
    }
  }

  // Собираем фронт по всем режимам прибытия в целевой узел и сводим их
  // между собой: прибытие фурой и вагоном конкурируют на равных.
  const finalSet = [];
  const crossDominated = [];
  for (const [key, bucket] of buckets) {
    if (!key.startsWith(`${toId}|`)) continue;
    for (const label of bucket) {
      const before = finalSet.slice();
      if (!insertNonDominated(finalSet, label)) {
        crossDominated.push(label);
        continue;
      }
      for (const old of before) if (!finalSet.includes(old)) crossDominated.push(old);
    }
  }

  const pareto = finalSet.map((l) => materialize(l, ctx));
  const dominated = dominatedAtTarget
    .concat(crossDominated)
    .map((l) => materialize(l, ctx));

  // Дедлайн отсёк вообще всё — повторяем поиск без срока и честно
  // помечаем результат как невыполнимый, вместо того чтобы отдать пустоту.
  if (pareto.length === 0 && !opts.ignoreDeadline && deadlineH != null) {
    const retry = paretoRoutes(fromId, toId, request, { ignoreDeadline: true });
    retry.stats.deadlineInfeasible = true;
    return retry;
  }

  // Стабильная сортировка: дешёвые сверху — так UI не прыгает между пересчётами.
  pareto.sort((a, b) => a.costKzt - b.costKzt || a.hours - b.hours);
  dominated.sort((a, b) => a.costKzt - b.costKzt || a.hours - b.hours);

  return { pareto, dominated, stats };
}

// ---------------------------------------------------------------------
//  ВЫБОР ТОЧКИ ФРОНТА ПО ВЕСАМ
// ---------------------------------------------------------------------

/**
 * Нормализованная взвешенная сумма.
 *
 * Критерии несоизмеримы: тенге считаются сотнями тысяч, часы десятками,
 * килограммы сотнями. Складывать их напрямую бессмысленно, поэтому каждый
 * критерий приводим к [0,1] по min-max внутри самого фронта — «худший
 * вариант = 1, лучший = 0». Тогда веса пользователя означают ровно то,
 * что он думает: «время вдвое важнее денег».
 *
 * @param {Array} routes
 * @param {{cost?:number,time?:number,co2?:number}} [weights]
 * @returns {Object|null} лучший маршрут или null для пустого списка
 */
export function pickByWeights(routes, weights = {}) {
  if (!routes || routes.length === 0) return null;
  if (routes.length === 1) return routes[0];

  const w = normalizeWeights(weights);

  const range = (key) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const r of routes) {
      if (r[key] < lo) lo = r[key];
      if (r[key] > hi) hi = r[key];
    }
    return { lo, span: hi - lo };
  };

  const c = range('costKzt');
  const t = range('hours');
  const e = range('co2Kg');

  // span = 0 означает, что критерий одинаков у всех и различать по нему нечего.
  const norm = (v, r) => (r.span > EPS ? (v - r.lo) / r.span : 0);

  let best = null;
  let bestScore = Infinity;
  for (const r of routes) {
    const score =
      w.cost * norm(r.costKzt, c) +
      w.time * norm(r.hours, t) +
      w.co2 * norm(r.co2Kg, e);
    if (score < bestScore - EPS) {
      bestScore = score;
      best = r;
    }
  }
  return best;
}

/** Приводит веса к сумме 1. Пустые/нулевые веса — равные приоритеты. */
export function normalizeWeights(weights = {}) {
  const cost = Math.max(0, weights.cost ?? 0);
  const time = Math.max(0, weights.time ?? 0);
  const co2 = Math.max(0, weights.co2 ?? 0);
  const sum = cost + time + co2;
  if (sum <= 0) return { cost: 1 / 3, time: 1 / 3, co2: 1 / 3 };
  return { cost: cost / sum, time: time / sum, co2: co2 / sum };
}
