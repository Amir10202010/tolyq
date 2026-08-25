// =====================================================================
//  TOLYQ — КОНТРАКТ МЕЖДУ ИНТЕРФЕЙСОМ И ДВИЖКОМ
// ---------------------------------------------------------------------
//  Пишем ВМЕСТЕ, коммитим ПЕРВЫМ, дальше не меняем без согласования обоих.
//  A строит UI по этим типам, B пишет движок под них.
//  Пока движка нет — A работает на моках той же формы.
// =====================================================================

/** Узлы транспортной сети Казахстана */
export const NODES = [
  { id: 'AST', name: 'Астана',    lat: 51.13, lon: 71.43, rail: true,  road: true,  hub: true  },
  { id: 'ALA', name: 'Алматы',    lat: 43.24, lon: 76.89, rail: true,  road: true,  hub: true  },
  { id: 'SHY', name: 'Шымкент',   lat: 42.32, lon: 69.59, rail: true,  road: true,  hub: true  },
  { id: 'KGF', name: 'Караганда', lat: 49.80, lon: 73.10, rail: true,  road: true,  hub: true },
  { id: 'AKX', name: 'Актобе',    lat: 50.28, lon: 57.17, rail: true,  road: true,  hub: false },
  { id: 'ATX', name: 'Атырау',    lat: 47.09, lon: 51.92, rail: true,  road: true,  hub: false },
  { id: 'KSN', name: 'Костанай',  lat: 53.21, lon: 63.62, rail: true,  road: true,  hub: false },
  { id: 'PWQ', name: 'Павлодар',  lat: 52.29, lon: 76.97, rail: true,  road: true,  hub: false },
  { id: 'DMB', name: 'Тараз',     lat: 42.90, lon: 71.39, rail: true,  road: true,  hub: false },
  { id: 'SCO', name: 'Актау',     lat: 43.65, lon: 51.16, rail: true,  road: true,  hub: true  }, // порт
  { id: 'KHG', name: 'Хоргос',    lat: 44.21, lon: 80.40, rail: true,  road: true,  hub: true  }, // граница КНР
  { id: 'DOS', name: 'Достык',    lat: 45.25, lon: 82.49, rail: true,  road: false, hub: true  }, // граница КНР
];

/** Типы груза. Химию нельзя везти вместе с продуктами. */
export const CARGO_TYPES = {
  food:     'Продукты',
  general:  'Генеральный груз',
  chemical: 'Химия',
};

/** Виды транспорта на рёбрах графа */
export const MODES = { road: 'Автотранспорт', rail: 'Железная дорога' };

/**
 * Заявка отправителя.
 * @typedef  {Object} ShipmentRequest
 * @property {string} from      id узла из NODES
 * @property {string} to        id узла из NODES
 * @property {number} tons
 * @property {number} volumeM3
 * @property {'food'|'general'|'chemical'} cargoType
 * @property {number} deadlineH через сколько часов груз должен быть на месте
 * @property {Object} [weights] предпочтения пользователя для выбора из фронта
 * @property {number} [weights.cost] 0..1
 * @property {number} [weights.time] 0..1
 * @property {number} [weights.co2]  0..1
 */

/**
 * Участок пути одним видом транспорта.
 * @typedef  {Object} Leg
 * @property {string} from
 * @property {string} to
 * @property {'road'|'rail'} mode
 * @property {number} km
 * @property {number} hours
 * @property {number} costKzt
 * @property {number} co2Kg
 * @property {boolean} transshipment была ли перегрузка ПЕРЕД этим участком
 */

/**
 * Один недоминируемый маршрут — точка на фронте Парето.
 * @typedef  {Object} Route
 * @property {string}  id
 * @property {Leg[]}   legs
 * @property {number}  costKzt
 * @property {number}  hours
 * @property {number}  co2Kg
 * @property {number}  fillPct       загрузка транспорта на лимитирующем участке
 * @property {boolean} multimodal    менялся ли вид транспорта
 * @property {boolean} feasible      влезает ли в дедлайн
 * @property {string}  label         'Только фура', 'Авто + ЖД через Караганду', ...
 */

/**
 * Политика оптимальной остановки — результат динамического программирования.
 * @typedef  {Object} StoppingPolicy
 * @property {number[]} thresholdByHour  для каждого часа t: порог тоннажа q*(t).
 *                                       Ждём, пока накоплено меньше порога.
 * @property {number}   expectedValueKzt ожидаемая стоимость при следовании политике
 * @property {number}   dispatchAtH      рекомендуемый час отправки при среднем сценарии
 * @property {number}   probability      вероятность собрать вагон в срок, 0..1
 * @property {number}   horizonH         на сколько часов вперёд считали
 */

/**
 * Результат упаковки вагона.
 * @typedef  {Object} PackResult
 * @property {Arrival[]} accepted
 * @property {Arrival[]} rejected
 * @property {number}    tonsTotal
 * @property {number}    fillPct
 * @property {number}    baselineFillPct  что дала жадная эвристика — для сравнения
 * @property {number}    iterations       сколько шагов сделал отжиг
 */

/**
 * Попутная заявка на плече. Используется в анимации.
 * @typedef  {Object} Arrival
 * @property {number}  atH
 * @property {number}  tons
 * @property {number}  volumeM3
 * @property {'food'|'general'|'chemical'} cargoType
 * @property {string}  shipper
 * @property {boolean} accepted
 */

/**
 * Полный ответ движка на заявку.
 * @typedef  {Object} Solution
 * @property {Route[]}        pareto       весь недоминируемый фронт
 * @property {Route[]}        dominated    отброшенные варианты — рисуем серым
 * @property {Route}          truckBaseline «как повёз бы отправитель сегодня»
 * @property {Route}          recommended  выбор по весам пользователя
 * @property {StoppingPolicy} stopping
 * @property {PackResult}     packing
 * @property {number}         savingKzt    рекомендованный против truckBaseline
 * @property {number}         savingCo2Kg
 * @property {string}         explanation  человеческая фраза на русском
 */

/**
 * Сводка прогона 30 дней по коридору.
 * @typedef  {Object} MonthSummary
 * @property {number} shipments
 * @property {number} trucksAvoided
 * @property {number} co2SavedKg
 * @property {number} kztSaved
 * @property {number} avgFillPct
 * @property {number[]} dailyTrucksAvoided  для графика
 */

// ---------------------------------------------------------------------
//  ПУБЛИЧНЫЙ API ДВИЖКА — больше UI ничего о нём не знает
// ---------------------------------------------------------------------
//   solve(request): Solution
//   simulateArrivals(request, horizonH, seed): Arrival[]
//   computeStopping(request, seed): StoppingPolicy
//   runMonth(fromId, toId, seed): MonthSummary
//   getNetwork(): { nodes, edges }        для отрисовки графа
// ---------------------------------------------------------------------