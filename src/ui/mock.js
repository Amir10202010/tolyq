// =====================================================================
//  TOLYQ / UI — МОКИ ДВИЖКА
// ---------------------------------------------------------------------
//  Файл повторяет публичный API движка один в один:
//      solve, simulateArrivals, computeStopping, runMonth, getNetwork
//  При интеграции в app.js меняется ОДНА строка импорта:
//      import * as engine from './mock.js'  ->  '../core/engine.js'
//  Файл после этого удаляется целиком.
// ---------------------------------------------------------------------
//  ДОПУЩЕНИЯ ПО КОНТРАКТУ — согласовать с разработчиком B:
//   1) getNetwork().edges — форма { from, to, mode, km }.
//      В types.js типа Edge нет. Если у движка другая — скажи, поправлю
//      только network-map.js, остальной UI рёбра не трогает.
//   2) Arrival.reason — необязательная строка с причиной отказа.
//      Нужна для анимации («химия рядом с продуктами»). Если движок её
//      не отдаёт, UI подставит нейтральное «не прошла упаковку».
//   3) Route.dominatedBy — необязательный id маршрута, который его
//      вытеснил. Нужен для подсказки на серых точках. Тоже не критично.
//   4) Leg.hours — чистое время хода по плечу, БЕЗ стоянки на перегрузку.
//      Стоянка учтена только в Route.hours, поэтому
//         сумма leg.hours + 4 ч × число перегрузок = route.hours.
//      Это важно: интерфейс печатает состав маршрута построчно, и если
//      перегрузку зашить внутрь leg.hours, строки не сойдутся с итогом.
//      UI на всякий случай считает стоянку как разницу и переживёт
//      обе трактовки, но давай держаться этой.
// =====================================================================

import { NODES, CARGO_TYPES, MODES } from '../core/types.js';

// ---------------------------------------------------------------------
//  СЕТЬ. Расстояния — порядок величины реальных плеч КТЖ и автодорог.
// ---------------------------------------------------------------------
const EDGE_SPEC = [
  // [откуда, куда, км автодорогой | null, км железной дорогой | null]
  ['AST', 'KGF',  220,  210],
  ['KGF', 'ALA', 1000, 1080],
  ['AST', 'PWQ',  450,  440],
  ['PWQ', 'KGF',  430,  420],
  ['PWQ', 'ALA', 1150, 1490],   // восточный ход, Турксиб
  ['AST', 'KSN',  700,  690],
  ['KSN', 'AKX',  750,  740],
  ['AKX', 'ATX',  850,  830],
  ['ATX', 'SCO',  600,  590],
  ['AKX', 'SCO', null,  900],
  ['AKX', 'SHY', 1600, 1550],
  ['SHY', 'DMB',  200,  190],
  ['DMB', 'ALA',  500,  490],
  ['ALA', 'KHG',  340,  330],
  ['KHG', 'DOS', null,  210],
  ['ALA', 'DOS', null,  560],
];

const EDGES = [];
for (const [a, b, kmRoad, kmRail] of EDGE_SPEC) {
  if (kmRoad) EDGES.push({ from: a, to: b, mode: 'road', km: kmRoad });
  if (kmRail) EDGES.push({ from: a, to: b, mode: 'rail', km: kmRail });
}

const NODE_BY_ID = Object.fromEntries(NODES.map(n => [n.id, n]));

/** Кратчайший по километражу путь одним видом транспорта. Дейкстра. */
function shortestPath(from, to, mode) {
  if (from === to) return [];
  const dist = new Map(NODES.map(n => [n.id, Infinity]));
  const prev = new Map();
  dist.set(from, 0);
  const unvisited = new Set(NODES.map(n => n.id));

  while (unvisited.size) {
    let cur = null, best = Infinity;
    for (const id of unvisited) if (dist.get(id) < best) { best = dist.get(id); cur = id; }
    if (cur === null) break;
    if (cur === to) break;
    unvisited.delete(cur);
    for (const e of EDGES) {
      if (e.mode !== mode) continue;
      const other = e.from === cur ? e.to : e.to === cur ? e.from : null;
      if (!other || !unvisited.has(other)) continue;
      const alt = dist.get(cur) + e.km;
      if (alt < dist.get(other)) { dist.set(other, alt); prev.set(other, [cur, e.km]); }
    }
  }
  if (!isFinite(dist.get(to))) return null;

  const hops = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur);
    if (!step) return null;
    hops.unshift({ from: step[0], to: cur, mode, km: step[1] });
    cur = step[0];
  }
  return hops;
}

/** Первый по ходу узел, где можно перегрузиться на железную дорогу. */
function railHubFor(from, to) {
  const road = shortestPath(from, to, 'road');
  if (!road || !road.length) return null;
  for (const hop of road) {
    const n = NODE_BY_ID[hop.to];
    if (n && n.rail && hop.to !== to) return hop.to;
  }
  return null;
}

const sum = (arr, key) => arr.reduce((a, x) => a + x[key], 0);
const round1 = v => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------
//  ШАБЛОНЫ СЕРВИСОВ
//  shape   — из чего собирается путь по графу
//  speed   — эффективная скорость, км/ч (уже с учётом стоянок)
//  cost    — costFixed + costPerTon * тонны, для базового коридора 1220 км
//
//  Стоимость фуры от тоннажа НЕ зависит: платишь за рейс, а не за тонны.
//  Это и есть та неделимость партии, из-за которой всё затевалось.
// ---------------------------------------------------------------------
const TRANSSHIP_H = 4;
const TRUCK_TONS  = 20;
const TRUCK_M3    = 82;
const WAGON_TONS  = 68;
const WAGON_M3    = 138;
const BASE_KM     = 1220;

const TEMPLATES = [
  { id: 'truck-direct', label: 'Только фура, выделенный рейс', shape: 'road', speed: 53,
    perTruck: true, costFixed: 390400, costPerTon: 0, co2Fixed: 1037, co2PerTon: 0, fillBy: 'truck',
    note: 'Машина едет под вас одну. Пустой объём оплачен полностью.' },

  { id: 'truck-shared', label: 'Фура с догрузом в пути', shape: 'road', speed: 46,
    costFixed: 140000, costPerTon: 19500, co2Fixed: 300, co2PerTon: 51.5, fillPct: 78,
    note: 'Экспедитор ищет попутный груз на том же плече.' },

  { id: 'road-rail-fast', label: 'Авто до узла + ЖД, ускоренный', shape: 'road-rail', speed: 53, railSpeed: 42,
    costFixed: 86000, costPerTon: 14050, co2Fixed: 180, co2PerTon: 36, fillPct: 86,
    note: 'Подвоз автотранспортом, дальше ускоренный поезд.' },

  { id: 'rail-container', label: 'ЖД, контейнерный поезд', shape: 'rail', railSpeed: 32,
    costFixed: 74000, costPerTon: 11250, co2Fixed: 140, co2PerTon: 25.25, fillPct: 91,
    note: 'Контейнер со станции отправления, без перегрузки в пути.' },

  { id: 'rail-group', label: 'ЖД, сборный вагон', shape: 'road-rail', speed: 53, railSpeed: 28.5,
    costFixed: 46000, costPerTon: 9025, co2Fixed: 105, co2PerTon: 17, fillPct: 94,
    note: 'Вагон собирается из партий нескольких отправителей.' },

  { id: 'rail-wait', label: 'ЖД, ожидание попутного вагона', shape: 'road-rail', speed: 53, railSpeed: 23.5,
    costFixed: 38000, costPerTon: 7300, co2Fixed: 100, co2PerTon: 16, fillPct: 97,
    note: 'Ждём на узле, пока наберётся полный вагон.' },

  { id: 'rail-detour', label: 'ЖД в обход, низкий тариф', shape: 'rail-detour', railSpeed: 32,
    costFixed: 34500, costPerTon: 6800, co2Fixed: 108, co2PerTon: 16, fillPct: 98,
    note: 'Длинное плечо в обход загруженного хода.' },

  // --- заведомо худшие варианты: доказательство, что перебор был честным ---
  { id: 'truck-night', label: 'Фура, экипаж из двух водителей', shape: 'road', speed: 52,
    perTruck: true, costFixed: 445000, costPerTon: 0, co2Fixed: 1090, co2PerTon: 0, fillBy: 'truck',
    note: 'Второй водитель почти не экономит время, но стоит денег.' },

  { id: 'truck-detour', label: 'Фура в обход по трассе', shape: 'road-detour', speed: 50,
    perTruck: true, costFixed: 428000, costPerTon: 0, co2Fixed: 1180, co2PerTon: 0, fillBy: 'truck',
    note: 'Объезд ремонта: крюк оплачивается километражом.' },

  { id: 'road-rail-slow', label: 'Авто в обход + ЖД', shape: 'road-rail-detour', speed: 50, railSpeed: 34,
    costFixed: 112000, costPerTon: 16750, co2Fixed: 220, co2PerTon: 46, fillPct: 72,
    note: 'Перегрузка на дальнем узле: длиннее и дороже.' },

  { id: 'rail-covered', label: 'ЖД, отдельный крытый вагон', shape: 'rail', railSpeed: 29,
    costFixed: 268000, costPerTon: 10500, co2Fixed: 300, co2PerTon: 12.25, fillPct: 30,
    note: 'Вагон под вас одного: та же пустота, что и у фуры.' },

  { id: 'rail-wagon-slow', label: 'ЖД, повагонная отправка в обход', shape: 'rail-detour', railSpeed: 26,
    costFixed: 84000, costPerTon: 11750, co2Fixed: 260, co2PerTon: 16, fillPct: 88,
    note: 'Дёшево по тарифу, но срок уходит за неделю.' },

  { id: 'rail-plan', label: 'ЖД по плану формирования', shape: 'rail', railSpeed: 21,
    costFixed: 92000, costPerTon: 10250, co2Fixed: 260, co2PerTon: 16, fillPct: 90,
    note: 'Вагон идёт с сортировками на каждой станции.' },

  { id: 'truck-reefer', label: 'Фура-рефрижератор', shape: 'road', speed: 51,
    perTruck: true, costFixed: 462000, costPerTon: 0, co2Fixed: 1150, co2PerTon: 0, fillBy: 'truck',
    note: 'Холод нужен не всякому грузу, а платится всегда.' },

  { id: 'truck-relay', label: 'Фура с перецепкой полуприцепа', shape: 'road', speed: 48,
    perTruck: true, costFixed: 412000, costPerTon: 0, co2Fixed: 1060, co2PerTon: 0, fillBy: 'truck',
    note: 'Смена тягача в пути экономит водителя, но не километры.' },

  { id: 'road-rail-far', label: 'Авто до дальнего узла + ЖД', shape: 'road-rail-detour', speed: 48, railSpeed: 26,
    costFixed: 128000, costPerTon: 18100, co2Fixed: 240, co2PerTon: 50, fillPct: 70,
    note: 'Перегрузка на дальнем узле удлиняет оба плеча.' },

  { id: 'rail-container-wait', label: 'ЖД, контейнер с ожиданием подачи', shape: 'rail', railSpeed: 27,
    costFixed: 96000, costPerTon: 12500, co2Fixed: 190, co2PerTon: 27, fillPct: 84,
    note: 'Платформу под контейнер подают не в день заявки.' },

  { id: 'rail-group-slow', label: 'ЖД, сборный вагон с досмотром', shape: 'road-rail', speed: 53, railSpeed: 25,
    costFixed: 58000, costPerTon: 10200, co2Fixed: 130, co2PerTon: 20, fillPct: 92,
    note: 'Сборный груз досматривают на узле — плюс сутки.' },
];

// ---------------------------------------------------------------------
//  СБОРКА ПУТИ ПО ГРАФУ
// ---------------------------------------------------------------------
function buildHops(shape, from, to) {
  switch (shape) {
    case 'road': return shortestPath(from, to, 'road');
    case 'rail': return shortestPath(from, to, 'rail');

    case 'road-rail': {
      const hub = railHubFor(from, to);
      if (!hub) return null;
      const a = shortestPath(from, hub, 'road');
      const b = shortestPath(hub, to, 'rail');
      return a && b && a.length && b.length ? [...a, ...b] : null;
    }

    case 'road-detour': return detour(from, to, 'road');
    case 'rail-detour': return detour(from, to, 'rail');

    case 'road-rail-detour': {
      const mid = detourNode(from, to, 'road');
      if (!mid) return null;
      const a = shortestPath(from, mid, 'road');
      const b = shortestPath(mid, to, 'rail');
      return a && b && a.length && b.length ? [...a, ...b] : null;
    }

    default: return null;
  }
}

/** Промежуточный узел вне прямого хода — даёт правдоподобный крюк. */
function detourNode(from, to, mode) {
  const direct = shortestPath(from, to, mode);
  if (!direct) return null;
  const onDirect = new Set(direct.flatMap(h => [h.from, h.to]));
  let best = null, bestKm = Infinity;
  for (const n of NODES) {
    if (onDirect.has(n.id)) continue;
    const a = shortestPath(from, n.id, mode);
    const b = shortestPath(n.id, to, mode);
    if (!a || !b || !a.length || !b.length) continue;
    const km = sum(a, 'km') + sum(b, 'km');
    if (km < bestKm) { bestKm = km; best = n.id; }
  }
  return best;
}

function detour(from, to, mode) {
  const mid = detourNode(from, to, mode);
  if (!mid) return null;
  const a = shortestPath(from, mid, mode);
  const b = shortestPath(mid, to, mode);
  return a && b && a.length && b.length ? [...a, ...b] : null;
}

/** Раскидываем сумму по плечам пропорционально километражу, без потери копейки. */
function splitTotal(total, weights) {
  const s = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map(w => total * w / s);
  const out = raw.map(Math.floor);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  let rest = Math.round(total) - out.reduce((a, b) => a + b, 0);
  for (let k = 0; rest > 0; k++, rest--) out[order[k % out.length][1]]++;
  return out;
}

function buildRoute(tpl, req, corridorKm) {
  const hops = buildHops(tpl.shape, req.from, req.to);
  if (!hops || !hops.length) return null;

  const scale = corridorKm / BASE_KM;
  const tons  = Math.max(0.5, req.tons);
  const vol   = Math.max(1, req.volumeM3);

  // сколько машин придётся заказать — по массе ИЛИ по объёму, что жёстче
  const trucks = Math.max(1, Math.ceil(tons / TRUCK_TONS), Math.ceil(vol / TRUCK_M3));

  const costTotal = tpl.perTruck
    ? tpl.costFixed * scale * trucks
    : (tpl.costFixed + tpl.costPerTon * tons) * scale;
  const co2Total = tpl.perTruck
    ? tpl.co2Fixed * scale * trucks
    : (tpl.co2Fixed + tpl.co2PerTon * tons) * scale;

  // Часы. Leg.hours — ЧИСТОЕ время хода по плечу, без перегрузки.
  // Стоянка на перегрузку живёт только в Route.hours, поэтому
  //   сумма leg.hours + 4 ч × число перегрузок = route.hours.
  // Интерфейс на это опирается, когда рисует состав маршрута строками.
  let hoursTotal = 0;
  const legHours = [];
  let prevMode = null;
  for (const hop of hops) {
    const v = hop.mode === 'rail' ? (tpl.railSpeed || 32) : (tpl.speed || 53);
    // округляем ПЕРЕД суммированием, иначе напечатанные строки маршрута
    // не сойдутся с итогом на десятые доли часа
    const travel = round1(hop.km / v);
    if (prevMode && prevMode !== hop.mode) hoursTotal += TRANSSHIP_H;
    legHours.push(travel);
    hoursTotal += travel;
    prevMode = hop.mode;
  }

  const kmWeights = hops.map(h => h.km);
  const costParts = splitTotal(Math.round(costTotal / 100) * 100, kmWeights);
  const co2Parts  = splitTotal(Math.round(co2Total), kmWeights);

  prevMode = null;
  const legs = hops.map((hop, i) => {
    const transshipment = prevMode !== null && prevMode !== hop.mode;
    prevMode = hop.mode;
    return {
      from: hop.from, to: hop.to, mode: hop.mode, km: hop.km,
      hours: legHours[i],
      costKzt: costParts[i],
      co2Kg: co2Parts[i],
      transshipment,
    };
  });

  // Загрузка транспорта. У выделенной фуры она считается от вашей партии:
  // именно этот процент и оплачивается целиком. Масса и объём расходятся,
  // поэтому показываем обе — в этом сценарии лимитирует объём.
  const isTruck = tpl.fillBy === 'truck';
  const capT  = isTruck ? TRUCK_TONS * trucks : WAGON_TONS;
  const capV  = isTruck ? TRUCK_M3   * trucks : WAGON_M3;
  const fillMassPct = Math.round(Math.min(100, tons / capT * 100));
  const fillVolPct  = Math.round(Math.min(100, vol  / capV * 100));
  const fillPct = isTruck ? fillMassPct : tpl.fillPct;

  return {
    id: tpl.id,
    legs,
    costKzt: costParts.reduce((a, b) => a + b, 0),
    hours: round1(hoursTotal),
    co2Kg: co2Parts.reduce((a, b) => a + b, 0),
    fillPct,
    multimodal: new Set(legs.map(l => l.mode)).size > 1,
    feasible: round1(hoursTotal) <= req.deadlineH,
    label: tpl.label,
    // --- расширения контракта, UI переживёт их отсутствие ---
    note: tpl.note,
    km: sum(hops, 'km'),
    path: [hops[0].from, ...hops.map(h => h.to)],
    trucks: tpl.perTruck ? trucks : null,
    fillMassPct,
    fillVolPct: isTruck ? fillVolPct : null,
  };
}

/** Недоминируемые сразу по трём критериям: дешевле, быстрее, чище. */
function paretoSplit(routes) {
  const front = [], dominated = [];
  for (const r of routes) {
    const killer = routes.find(o =>
      o !== r &&
      o.costKzt <= r.costKzt && o.hours <= r.hours && o.co2Kg <= r.co2Kg &&
      (o.costKzt < r.costKzt || o.hours < r.hours || o.co2Kg < r.co2Kg));
    if (killer) dominated.push({ ...r, dominatedBy: killer.id });
    else front.push(r);
  }
  return { front, dominated };
}

function normWeights(w) {
  const cost = w?.cost ?? 0.5, time = w?.time ?? 0.3, co2 = w?.co2 ?? 0.2;
  const s = cost + time + co2 || 1;
  return { cost: cost / s, time: time / s, co2: co2 / s };
}

/** Свёртка трёх критериев в один балл по ползункам пользователя. */
function scoreRoutes(routes, weights) {
  if (!routes.length) return [];
  const span = key => {
    const vals = routes.map(r => r[key]);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    return v => (hi - lo < 1e-9 ? 0 : (v - lo) / (hi - lo));
  };
  const nc = span('costKzt'), nt = span('hours'), ne = span('co2Kg');
  const w = normWeights(weights);
  return routes
    .map(r => ({ route: r, score: w.cost * nc(r.costKzt) + w.time * nt(r.hours) + w.co2 * ne(r.co2Kg) }))
    .sort((a, b) => a.score - b.score);
}

// =====================================================================
//  ПУБЛИЧНЫЙ API ДВИЖКА
// =====================================================================

export function getNetwork() {
  return { nodes: NODES, edges: EDGES };
}

export function solve(request) {
  const req = {
    from: 'AST', to: 'ALA', tons: 8, volumeM3: 52,
    cargoType: 'food', deadlineH: 48,
    ...request,
    weights: normWeights(request?.weights),
  };

  const roadPath = shortestPath(req.from, req.to, 'road');
  const railPath = shortestPath(req.from, req.to, 'rail');
  const corridorKm = roadPath && roadPath.length ? sum(roadPath, 'km')
    : railPath && railPath.length ? sum(railPath, 'km')
    : BASE_KM;

  const all = TEMPLATES.map(t => buildRoute(t, req, corridorKm)).filter(Boolean);
  const deduped = dedupe(all);
  const { front, dominated } = paretoSplit(deduped);

  const truckBaseline = deduped.find(r => r.id === 'truck-direct') || deduped[0];

  const feasible = front.filter(r => r.feasible);
  const pool = feasible.length ? feasible : front;
  const recommended = scoreRoutes(pool, req.weights)[0]?.route || truckBaseline;

  const savingKzt   = truckBaseline.costKzt - recommended.costKzt;
  const savingCo2Kg = truckBaseline.co2Kg   - recommended.co2Kg;

  return {
    pareto: front.slice().sort((a, b) => a.hours - b.hours),
    dominated,
    truckBaseline,
    recommended,
    stopping: computeStopping(req),
    packing: packing(req),
    savingKzt,
    savingCo2Kg,
    explanation: explain(req, recommended, truckBaseline, savingKzt, savingCo2Kg),
    considered: deduped.length,   // расширение: для заголовка панели
  };
}

/** Шаблоны на коротком коридоре могут схлопнуться в один и тот же путь. */
function dedupe(routes) {
  const seen = new Map();
  for (const r of routes) {
    const key = r.path.join('>') + '|' + r.legs.map(l => l.mode).join('') + '|' + r.hours + '|' + r.costKzt;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

function explain(req, rec, base, savingKzt, savingCo2) {
  const A = NODE_BY_ID[req.from]?.name || req.from;
  const B = NODE_BY_ID[req.to]?.name   || req.to;
  if (rec.id === base.id) {
    return `На плече ${A} — ${B} со сроком ${req.deadlineH} ч ничего дешевле выделенной фуры не проходит: ` +
           `железная дорога не успевает. Добавьте сроку сутки — появится сборный вагон.`;
  }
  const spare = round1(Math.max(0, req.deadlineH - rec.hours));
  return `${rec.label}: вы платите за ${fmtT(req.tons)} т из ${WAGON_TONS}, а не за пустую фуру. ` +
         `Экономия ${Math.round(savingKzt).toLocaleString('ru-RU')} ₸ и ${Math.round(savingCo2)} кг CO₂ ` +
         `при запасе ${fmtT(spare)} ч до срока.`;
}
const fmtT = v => String(Math.round(v * 10) / 10).replace('.', ',');

// ---------------------------------------------------------------------
//  ПОПУТНЫЕ ЗАЯВКИ
//  Сценарий подобран руками: он должен читаться с экрана как история,
//  а не как случайный шум. Объём здесь лимитирует раньше массы — это
//  видно на демо и объясняет отказ «Береке Трейд».
// ---------------------------------------------------------------------
const ARRIVAL_SCRIPT = [
  { atH: 2,  tons: 11, volumeM3: 17, cargoType: 'food',     shipper: 'ТОО «Астық Астана»' },
  { atH: 4,  tons: 14, volumeM3: 22, cargoType: 'chemical', shipper: 'ТОО «Химпром КЗ»' },
  { atH: 5,  tons: 6,  volumeM3: 9,  cargoType: 'general',  shipper: 'ИП Ералиев' },
  { atH: 8,  tons: 9,  volumeM3: 14, cargoType: 'food',     shipper: 'ТОО «Қарағанды Сүт»' },
  { atH: 9,  tons: 7,  volumeM3: 52, cargoType: 'general',  shipper: 'ТОО «Береке Трейд»' },
  { atH: 11, tons: 12, volumeM3: 19, cargoType: 'food',     shipper: 'ТОО «Сарыарқа Дән»' },
  { atH: 13, tons: 18, volumeM3: 26, cargoType: 'general',  shipper: 'АО «Тұлпар Логистик»' },
  { atH: 16, tons: 9,  volumeM3: 13, cargoType: 'general',  shipper: 'ТОО «Дән Экспорт»' },
];

export function simulateArrivals(request, horizonH = 24) {
  const req = { tons: 8, volumeM3: 52, cargoType: 'food', ...request };

  const mine = {
    atH: 0, tons: req.tons, volumeM3: req.volumeM3, cargoType: req.cargoType,
    shipper: 'Ваша партия', accepted: true, mine: true,
  };

  let tons = req.tons, vol = req.volumeM3;
  let dispatched = false;
  const out = [mine];

  for (const a of ARRIVAL_SCRIPT) {
    if (a.atH > horizonH) break;
    let accepted = true, reason = null;

    if (dispatched) {
      accepted = false; reason = 'Вагон уже отправлен';
    } else if (incompatible(a.cargoType, req.cargoType)) {
      accepted = false;
      reason = `${CARGO_TYPES[a.cargoType]} не едет рядом с грузом «${CARGO_TYPES[req.cargoType]}»`;
    } else if (tons + a.tons > WAGON_TONS) {
      accepted = false; reason = 'Не влезает по массе';
    } else if (vol + a.volumeM3 > WAGON_M3) {
      accepted = false; reason = 'Не влезает по объёму';
    }

    if (accepted) { tons += a.tons; vol += a.volumeM3; }
    out.push({ ...a, accepted, reason });

    // после пересечения порога вагон уходит — дальше только отказы
    if (accepted && tons >= thresholdAt(a.atH, horizonH)) dispatched = true;
  }
  return out;
}

/** Химию нельзя везти вместе с продуктами. Остальное совместимо. */
function incompatible(a, b) {
  return (a === 'chemical' && b === 'food') || (a === 'food' && b === 'chemical');
}

// ---------------------------------------------------------------------
//  ОПТИМАЛЬНАЯ ОСТАНОВКА
//  Порог держится у полного вагона, пока времени много: отправляться рано
//  имеет смысл только с полной загрузкой. Ближе к сроку планка обваливается.
// ---------------------------------------------------------------------
function thresholdAt(t, horizonH) {
  const x = Math.min(1, Math.max(0, t / horizonH));
  return round1(10 + (WAGON_TONS - 10) * (1 - Math.pow(x, 3)));
}

export function computeStopping(request) {
  const req = { tons: 8, volumeM3: 52, cargoType: 'food', deadlineH: 48, ...request };
  const horizonH = 24;

  const thresholdByHour = [];
  for (let t = 0; t <= horizonH; t++) thresholdByHour.push(thresholdAt(t, horizonH));

  const arrivals = simulateArrivals(req, horizonH);
  let acc = 0, dispatchAtH = horizonH;
  for (const a of arrivals) {
    if (!a.accepted) continue;
    acc += a.tons;
    if (acc >= thresholdByHour[Math.min(horizonH, Math.round(a.atH))]) { dispatchAtH = a.atH; break; }
  }

  return {
    thresholdByHour,
    expectedValueKzt: 118200,
    dispatchAtH,
    probability: 0.86,
    horizonH,
  };
}

export function packing(request) {
  const req = { tons: 8, volumeM3: 52, cargoType: 'food', ...request };
  const arrivals = simulateArrivals(req, 24);
  const accepted = arrivals.filter(a => a.accepted);
  const rejected = arrivals.filter(a => !a.accepted);
  const tonsTotal  = accepted.reduce((s, a) => s + a.tons, 0);
  const volumeTotal = accepted.reduce((s, a) => s + a.volumeM3, 0);
  return {
    accepted, rejected, tonsTotal,
    fillPct: Math.round(tonsTotal / WAGON_TONS * 100),
    baselineFillPct: 78,
    iterations: 12480,
    // расширение: в этом сценарии лимитирует объём, а не масса
    volumeM3: volumeTotal,
    volumePct: Math.round(volumeTotal / WAGON_M3 * 100),
  };
}

// ---------------------------------------------------------------------
//  ПРОГОН 30 ДНЕЙ
// ---------------------------------------------------------------------
function lcg(seed) {
  let s = (seed >>> 0) || 42;
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
}

export function runMonth(fromId = 'AST', toId = 'ALA', seed = 7) {
  const rnd = lcg(seed);
  const daily = [];
  for (let d = 0; d < 30; d++) {
    const weekday = (d + 1) % 7;
    const weekend = (weekday === 0 || weekday === 6) ? 0.45 : 1;
    daily.push(Math.max(0, Math.round((2 + rnd() * 4) * weekend)));
  }
  const trucksAvoided = daily.reduce((a, b) => a + b, 0);
  return {
    shipments: 214,
    trucksAvoided,
    co2SavedKg: Math.round(trucksAvoided * 796),
    kztSaved: Math.round(trucksAvoided * 272200),
    avgFillPct: 91,
    dailyTrucksAvoided: daily,
  };
}

export const CONSTANTS = { WAGON_TONS, WAGON_M3, TRUCK_TONS, TRUCK_M3, TRANSSHIP_H };
export { CARGO_TYPES, MODES, NODES, NODE_BY_ID };
