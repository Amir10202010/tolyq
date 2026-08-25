// =====================================================================
//  TOLYQ / UI — ПРОСЛОЙКА МЕЖДУ ИНТЕРФЕЙСОМ И ДВИЖКОМ
// ---------------------------------------------------------------------
//  Движок отвечает почти ровно по контракту, но не совсем: часть полей,
//  на которые опирается интерфейс, он не отдаёт, а часть называет иначе.
//  Чинить это внутри визуализаций нельзя — тогда каждая из них начнёт
//  знать про движок. Поэтому всё сведение живёт здесь, в одном файле.
//
//  Интерфейс импортирует ТОЛЬКО этот модуль. Когда движок начнёт отдавать
//  недостающее сам, отсюда просто уйдут соответствующие куски.
//
//  ЧТО ДОБАВЛЯЕТСЯ К ОТВЕТУ ДВИЖКА (и почему):
//   1) CONSTANTS      — движок держит вместимости в network.js, но не
//                       реэкспортирует их через solve.js;
//   2) CARGO_TYPES    — то же самое для справочника типов груза;
//   3) considered     — сколько вариантов перебрано; у движка это
//                       stats.generated;
//   4) dominatedBy    — кем вытеснен отброшенный маршрут. Без этого
//                       серые точки и строки становятся яркими, и
//                       пропадает главное: видно, что перебор был честным;
//   5) mine у заявки  — своя партия в вагоне. Движок собирает вагон из
//                       чужих партий и вашу в накопление не кладёт;
//   6) trucks         — сколько машин потребовал бы выделенный рейс.
// =====================================================================

import * as core from '../core/solve.js';
import { NODES, CARGO_TYPES, MODES } from '../core/types.js';
import { TRUCK_CAP_T, TRUCK_CAP_M3, WAGON_CAP_T, WAGON_CAP_M3 } from '../core/network.js';

export { NODES, CARGO_TYPES, MODES };

export const CONSTANTS = {
  TRUCK_TONS:  TRUCK_CAP_T,
  TRUCK_M3:    TRUCK_CAP_M3,
  WAGON_TONS:  WAGON_CAP_T,
  WAGON_M3:    WAGON_CAP_M3,
  TRANSSHIP_H: transshipHoursOf(),
};

/** Часы перегрузки движок кладёт в getNetwork(); запасное значение — 4 ч. */
function transshipHoursOf() {
  try {
    const t = core.getNetwork()?.transshipment;
    if (typeof t === 'number') return t;
    if (t && typeof t.hours === 'number') return t.hours;
  } catch { /* сеть ещё не готова — берём запасное */ }
  return 4;
}

export const getNetwork       = (...a) => core.getNetwork(...a);
export const simulateArrivals = (...a) => core.simulateArrivals(...a);
export const computeStopping  = (...a) => core.computeStopping(...a);
export const runMonth         = (...a) => core.runMonth(...a);

/**
 * Движок может отвечать и синхронно, и обещанием — интерфейс терпит оба
 * варианта, поэтому здесь ничего не разворачиваем принудительно.
 */
export function solve(request) {
  const answer = core.solve(request);
  return answer && typeof answer.then === 'function'
    ? answer.then(sol => normalise(sol, request))
    : normalise(answer, request);
}

// ---------------------------------------------------------------------
//  Сведение ответа к тому, что ждёт интерфейс
// ---------------------------------------------------------------------
function normalise(sol, request) {
  if (!sol || !sol.recommended) return sol;

  const pareto    = sol.pareto || [];
  const dominated = (sol.dominated || []).map(r => ({
    ...r,
    dominatedBy: r.dominatedBy || whoDominates(r, pareto),
  }));

  const truckBaseline = withTruckCount(sol.truckBaseline, request);

  return {
    ...sol,
    pareto,
    dominated,
    truckBaseline,
    recommended: sol.recommended.id === sol.truckBaseline?.id ? truckBaseline : sol.recommended,
    packing: withOwnParcel(sol.packing, request),
    considered: sol.considered ?? sol.stats?.generated ?? (pareto.length + dominated.length),
  };
}

/** Кто именно вытеснил этот маршрут: не хуже по всем трём и лучше хоть в чём-то. */
function whoDominates(route, pareto) {
  const killer = pareto.find(o =>
    o.costKzt <= route.costKzt && o.hours <= route.hours && o.co2Kg <= route.co2Kg &&
    (o.costKzt < route.costKzt || o.hours < route.hours || o.co2Kg < route.co2Kg));
  // Маршрут лежит в dominated — значит вытеснен. Если по трём критериям
  // виновник не нашёлся, движок отбросил его по своей причине; помечаем
  // хотя бы фактом, иначе точка станет яркой и соврёт.
  return killer ? killer.id : (pareto[0]?.id ?? null);
}

/** Выделенный рейс: сколько машин пришлось бы заказать под эту партию. */
function withTruckCount(base, request) {
  if (!base) return base;
  const trucks = Math.max(1,
    Math.ceil((request.tons || 0) / CONSTANTS.TRUCK_TONS),
    Math.ceil((request.volumeM3 || 0) / CONSTANTS.TRUCK_M3));
  return {
    ...base,
    trucks: base.trucks ?? trucks,
    fillMassPct: base.fillMassPct ?? Math.round(Math.min(100,
      (request.tons || 0) / (CONSTANTS.TRUCK_TONS * trucks) * 100)),
    fillVolPct: base.fillVolPct ?? Math.round(Math.min(100,
      (request.volumeM3 || 0) / (CONSTANTS.TRUCK_M3 * trucks) * 100)),
  };
}

/**
 * Движок набирает вагон из чужих партий, а вашу в накопление не кладёт —
 * она и есть повод для расчёта. Для сцены сборки это принципиально:
 * без неё зритель не видит, ради чего вагон собирают.
 *
 * СОГЛАСОВАТЬ С ДВИЖКОМ: если он начнёт возвращать свою партию сам,
 * этот блок надо убрать, иначе она задвоится.
 */
function withOwnParcel(packing, request) {
  if (!packing) return packing;
  const accepted = packing.accepted || [];
  if (accepted.some(a => a.mine)) return packing;

  const mine = {
    atH: 0,
    tons: request.tons,
    volumeM3: request.volumeM3,
    cargoType: request.cargoType,
    shipper: 'Ваша партия',
    accepted: true,
    mine: true,
  };

  return {
    ...packing,
    accepted: [mine, ...accepted],
    tonsTotal: (packing.tonsTotal ?? 0) + request.tons,
  };
}
