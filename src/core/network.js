// =====================================================================
//  TOLYQ — МУЛЬТИМОДАЛЬНАЯ ТРАНСПОРТНАЯ СЕТЬ КАЗАХСТАНА
// ---------------------------------------------------------------------
//  Граф: 12 узлов из types.js, 28 рёбер (road + rail на связанных парах).
//  Перегрузка между видами транспорта возможна ТОЛЬКО в узлах hub:true.
//
//  ВСЕ тарифы — заглушки. Найти одним grep:
//      grep -n "ЗАГЛУШКА" src/core/network.js
//  Реальные ставки подставляет третий участник команды; менять надо
//  только константы в блоке ТАРИФЫ, значения на рёбрах производные.
// =====================================================================

import { NODES } from './types.js';

// ---------------------------------------------------------------------
//  ВМЕСТИМОСТЬ ЕДИНИЦЫ ПОДВИЖНОГО СОСТАВА
// ---------------------------------------------------------------------
export const TRUCK_CAP_T = 20;
export const TRUCK_CAP_M3 = 86;
export const WAGON_CAP_T = 68;
export const WAGON_CAP_M3 = 120;

// ---------------------------------------------------------------------
//  ВЫБРОСЫ
// ---------------------------------------------------------------------
/** Фура целиком: выброс слабо зависит от загрузки, поэтому на км, а не на ткм. */
export const TRUCK_CO2_KG_PER_KM = 0.85;

/**
 * ЖД, грамм на тонно-километр.
 * Европейское справочное значение ~17,4 г/ткм (EEA, электрифицированная тяга).
 * В Казахстане берём 22 г/ткм с запасом: генерация преимущественно угольная,
 * часть направлений (Достык, западные плечи) обслуживается тепловозами.
 * Занижать нельзя — весь экологический аргумент проекта строится на этом числе,
 * и он должен выдерживать критику в сторону «вы взяли слишком красивую цифру».
 */
export const RAIL_CO2_G_PER_TKM = 22;

/** Одна операция перегрузки: маневровая работа + погрузчик. ОЦЕНКА. */
export const TRANSSHIP_CO2_KG = 12;

// ---------------------------------------------------------------------
//  СКОРОСТИ И ВРЕМЕННЫЕ НАКЛАДНЫЕ
// ---------------------------------------------------------------------
/** Фура: 60 км/ч — средняя по маршруту с учётом обязательного отдыха водителя. */
export const TRUCK_KMH = 60;
/** Состав в движении: 35 км/ч — средняя с учётом стоянок и скрещений. */
export const RAIL_KMH = 35;
/** Приём/сдача и формирование состава на концах плеча, часов. */
export const RAIL_TERMINAL_H = 1.5;

// ---------------------------------------------------------------------
//  ТАРИФЫ — ЗАГЛУШКА, ЗАМЕНИТЬ РЕАЛЬНЫМИ СТАВКАМИ
// ---------------------------------------------------------------------
/** ЗАГЛУШКА — заменить реальной ставкой: аренда фуры 20 т, тенге за км. */
export const TRUCK_KZT_PER_KM = 442;
/** ЗАГЛУШКА — заменить реальной ставкой: вагон 68 т, тенге за км. */
export const RAIL_KZT_PER_KM = 245;
/** ЗАГЛУШКА — заменить реальной ставкой: подача/уборка вагона, разовый сбор. */
export const RAIL_FIXED_KZT = 13000;
/** ЗАГЛУШКА — заменить реальной ставкой: перегрузка вагон↔фуры на хабе. */
export const TRANSSHIP_KZT_PER_WAGON = 45000;
/** Перегрузка стоит времени: подача, кран, оформление. */
export const TRANSSHIP_HOURS = 4;
/**
 * ЗАГЛУШКА — заменить реальной ставкой: минимальная тарифицируемая доля вагона.
 * Перевозчик не продаёт долю меньше этой, даже если груза совсем мало, —
 * иначе оптимизатор «выторговывает» тонну за копейки и врёт в экономии.
 */
export const MIN_WAGON_SHARE = 0.15;
/**
 * Загрузка вагона, на которую рассчитываем при подборе маршрута, тонн.
 * 75 % от вместимости — консервативная цель консолидации: полный вагон
 * собрать в срок обычно не удаётся. Фактическую загрузку считает stopping.js,
 * и solve() пересчитывает по ней рекомендованный маршрут.
 */
export const ASSUMED_WAGON_FILL_T = WAGON_CAP_T * 0.75;

/** Стоимость и время перегрузки в узле. Одинаковы для всех хабов. */
export const transshipment = {
  hours: TRANSSHIP_HOURS,
  kztPerWagon: TRANSSHIP_KZT_PER_WAGON,
};

// ---------------------------------------------------------------------
//  ОПОРНЫЕ ПЛЕЧИ
// ---------------------------------------------------------------------
//  km    — расстояние по соответствующей инфраструктуре (ЖД длиннее автодороги);
//  modes — какими видами транспорта плечо проходимо;
//  perDay— базовая интенсивность попутных заявок на плече, шт/сутки.
//          Магистраль Астана—Караганда—Алматы загружена, западные плечи редкие.
//          Используется market.js как базовая λ.
// ---------------------------------------------------------------------
const CORRIDORS = [
  // Центральная магистраль
  { a: 'AST', b: 'KGF', roadKm: 215, railKm: 230, modes: ['road', 'rail'], perDay: 7.0 },
  { a: 'KGF', b: 'ALA', roadKm: 1050, railKm: 1160, modes: ['road', 'rail'], perDay: 5.5 },
  // Север
  { a: 'AST', b: 'KSN', roadKm: 700, railKm: 760, modes: ['road', 'rail'], perDay: 3.2 },
  { a: 'AST', b: 'PWQ', roadKm: 440, railKm: 460, modes: ['road', 'rail'], perDay: 3.6 },
  { a: 'KGF', b: 'PWQ', roadKm: 480, railKm: 520, modes: ['road', 'rail'], perDay: 2.4 },
  // Запад
  { a: 'AST', b: 'AKX', roadKm: 1330, railKm: 1420, modes: ['road', 'rail'], perDay: 2.6 },
  { a: 'KSN', b: 'AKX', roadKm: 780, railKm: 830, modes: ['road', 'rail'], perDay: 1.8 },
  { a: 'AKX', b: 'ATX', roadKm: 850, railKm: 900, modes: ['road', 'rail'], perDay: 2.2 },
  { a: 'ATX', b: 'SCO', roadKm: 720, railKm: 780, modes: ['road', 'rail'], perDay: 2.0 },
  // Юг
  { a: 'AKX', b: 'SHY', roadKm: 1400, railKm: 1480, modes: ['road', 'rail'], perDay: 2.1 },
  { a: 'SHY', b: 'DMB', roadKm: 200, railKm: 220, modes: ['road', 'rail'], perDay: 5.0 },
  { a: 'DMB', b: 'ALA', roadKm: 480, railKm: 520, modes: ['road', 'rail'], perDay: 4.8 },
  // Границы и порт
  { a: 'ALA', b: 'KHG', roadKm: 330, railKm: 380, modes: ['road', 'rail'], perDay: 4.2 },
  // Достык — станция без автодорожного пункта пропуска (road:false в types.js)
  { a: 'ALA', b: 'DOS', roadKm: null, railKm: 620, modes: ['rail'], perDay: 3.0 },
  // Порт Актау с юга: ЖД-коридор через Бейнеу—Кызылорду, автодороги нет
  { a: 'SHY', b: 'SCO', roadKm: null, railKm: 1750, modes: ['rail'], perDay: 1.4 },
];

// ---------------------------------------------------------------------
//  ПОСТРОЕНИЕ РЁБЕР
// ---------------------------------------------------------------------

/** Округление до 500 тенге — тарифы в прайсах не бывают до копейки. */
const round500 = (x) => Math.round(x / 500) * 500;
/** Округление часов до 0.1 — чтобы в UI не было 3.5833333. */
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Время хода по плечу.
 * Автотранспорт: чистый пробег на средней скорости.
 * ЖД: пробег + постоянные накладные на приём/сдачу (RAIL_TERMINAL_H).
 * Именно накладные объясняют, почему на коротком плече 230 км состав
 * идёт 8 часов, а не 6,5 — на длинных плечах они размазываются.
 */
function hoursFor(mode, km) {
  return mode === 'road'
    ? round1(km / TRUCK_KMH)
    : round1(km / RAIL_KMH + RAIL_TERMINAL_H);
}

/** Тариф за рейс единицы подвижного состава. ЗАГЛУШКА — производная от ставок выше. */
function tripCost(mode, km) {
  return mode === 'road'
    ? round500(km * TRUCK_KZT_PER_KM)
    : round500(km * RAIL_KZT_PER_KM + RAIL_FIXED_KZT);
}

const NODE_BY_ID = new Map(NODES.map((n) => [n.id, n]));

/**
 * Разворачивает коридоры в направленные рёбра (в обе стороны).
 * Ребро создаётся, только если ОБА конца поддерживают этот вид транспорта:
 * Достык road:false, поэтому автодорожных рёбер к нему не появится
 * даже при ошибке в таблице коридоров.
 */
function buildEdges() {
  const edges = [];
  for (const c of CORRIDORS) {
    const na = NODE_BY_ID.get(c.a);
    const nb = NODE_BY_ID.get(c.b);
    if (!na || !nb) throw new Error(`network: неизвестный узел в коридоре ${c.a}-${c.b}`);

    for (const mode of c.modes) {
      const km = mode === 'road' ? c.roadKm : c.railKm;
      if (km == null) continue;
      if (!na[mode] || !nb[mode]) continue; // узел не обслуживает этот вид транспорта

      const hours = hoursFor(mode, km);
      const cost = tripCost(mode, km);
      const base = {
        mode,
        km,
        hours,
        // ЗАГЛУШКА — заменить реальной ставкой (см. блок ТАРИФЫ выше)
        ...(mode === 'road' ? { kztPerTruckTrip: cost } : { kztPerWagonTrip: cost }),
        arrivalsPerDay: c.perDay,
      };
      edges.push({ from: c.a, to: c.b, ...base });
      edges.push({ from: c.b, to: c.a, ...base });
    }
  }
  return edges;
}

const EDGES = buildEdges();

/** Индекс: from -> mode -> список рёбер. Строится один раз при импорте. */
const ADJ = (() => {
  const m = new Map();
  for (const e of EDGES) {
    if (!m.has(e.from)) m.set(e.from, { road: [], rail: [] });
    m.get(e.from)[e.mode].push(e);
  }
  return m;
})();

// ---------------------------------------------------------------------
//  ПУБЛИЧНОЕ API
// ---------------------------------------------------------------------

/**
 * Полная сеть для отрисовки и для алгоритмов.
 * Возвращает те же замороженные объекты — движок ничего не мутирует,
 * UI тоже не должен (иначе перерасчёт с другими весами даст другой граф).
 * @returns {{nodes: Array, edges: Array, transshipment: {hours:number, kztPerWagon:number}}}
 */
export function getNetwork() {
  return { nodes: NODES, edges: EDGES, transshipment };
}

/**
 * Исходящие рёбра узла.
 * @param {string} nodeId
 * @param {'road'|'rail'} [mode] если не задан — оба вида транспорта
 * @returns {Array} рёбра (пустой массив для неизвестного узла)
 */
export function edgesFrom(nodeId, mode) {
  const rec = ADJ.get(nodeId);
  if (!rec) return [];
  if (mode) return rec[mode] || [];
  return rec.road.concat(rec.rail);
}

/** Узел по id или undefined. */
export function getNode(nodeId) {
  return NODE_BY_ID.get(nodeId);
}

/** Можно ли в этом узле менять вид транспорта. */
export function isHub(nodeId) {
  const n = NODE_BY_ID.get(nodeId);
  return !!(n && n.hub);
}

/**
 * Базовая интенсивность попутных заявок на плече between(a,b), шт/сутки.
 * Если прямого плеча нет — берём среднее по исходящим из a,
 * чтобы market.js не падал на составных маршрутах.
 */
export function arrivalsPerDayBetween(a, b) {
  const direct = edgesFrom(a).find((e) => e.to === b);
  if (direct) return direct.arrivalsPerDay;
  const out = edgesFrom(a);
  if (out.length === 0) return 1.0;
  return out.reduce((s, e) => s + e.arrivalsPerDay, 0) / out.length;
}

/** Диагностика: связен ли граф по объединению обоих видов транспорта. */
export function isConnected() {
  const seen = new Set([NODES[0].id]);
  const stack = [NODES[0].id];
  while (stack.length) {
    for (const e of edgesFrom(stack.pop())) {
      if (!seen.has(e.to)) {
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return seen.size === NODES.length;
}
