// =====================================================================
//  TOLYQ — ДЕТЕРМИНИРОВАННЫЙ ГПСЧ
// ---------------------------------------------------------------------
//  Math.random() в проекте запрещён. Любая случайность течёт только
//  отсюда и только через явный seed: один seed — одна и та же картинка
//  на защите, сколько бы раз мы её ни перезапускали.
//
//  Алгоритм: mulberry32 — 32-битный генератор, период 2^32,
//  проходит gjrand-тесты, целиком помещается в пять строк.
//  Выбран потому, что нам не нужна криптостойкость, нужна
//  воспроизводимость и отсутствие зависимостей.
// =====================================================================

/**
 * Хеш строки в 32-битное целое (xmur3).
 * Нужен, чтобы seed можно было задавать словом: makeRng('demo-ala').
 * @param {string} str
 * @returns {number} целое 0..2^32-1
 */
function hashSeed(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/**
 * Создаёт независимый поток псевдослучайных чисел.
 * Два вызова makeRng с одним seed дают идентичные последовательности.
 *
 * @param {number|string} seed
 * @returns {Rng}
 *
 * @typedef  {Object} Rng
 * @property {() => number}                    float  равномерное [0,1)
 * @property {(a:number,b:number) => number}   int    целое [a,b] включительно
 * @property {(mean:number) => number}         exp    экспоненциальное со средним mean
 * @property {(mu:number,sigma:number)=>number} normal нормальное N(mu, sigma)
 * @property {(mu:number,sigma:number)=>number} lognormal логнормальное
 * @property {(arr:Array,w?:number[]) => any}  pick   элемент по весам
 * @property {(arr:Array) => Array}            shuffle перемешанная КОПИЯ массива
 * @property {(p:number) => boolean}           bool   истина с вероятностью p
 * @property {(sub:string|number) => Rng}      fork   независимый поток от того же seed
 * @property {number}                          seed   исходный seed (для отладки)
 */
export function makeRng(seed) {
  const initial = typeof seed === 'string' ? hashSeed(seed) : (seed >>> 0);
  let a = initial;

  /** Ядро mulberry32. Все остальные распределения строятся поверх него. */
  const float = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  // Box-Muller выдаёт нормальные пары; вторую держим про запас,
  // иначе половина вычислений уходит в мусор.
  let spare = null;

  const normal = (mu = 0, sigma = 1) => {
    if (spare !== null) {
      const z = spare;
      spare = null;
      return mu + sigma * z;
    }
    // u строго > 0, иначе Math.log(0) = -Infinity
    let u = 0;
    while (u === 0) u = float();
    const v = float();
    const r = Math.sqrt(-2 * Math.log(u));
    const theta = 2 * Math.PI * v;
    spare = r * Math.sin(theta);
    return mu + sigma * (r * Math.cos(theta));
  };

  const rng = {
    seed: initial,
    float,
    normal,

    /** Целое в [a,b] включительно. При a > b возвращает a. */
    int(lo, hi) {
      if (hi < lo) return lo;
      return lo + Math.floor(float() * (hi - lo + 1));
    },

    /**
     * Экспоненциальное распределение методом обратной функции.
     * Используется для интервалов между заявками в пуассоновском потоке.
     */
    exp(mean) {
      if (!(mean > 0)) return 0;
      let u = 0;
      while (u === 0) u = float(); // -ln(0) = Infinity — обходим
      return -mean * Math.log(u);
    },

    /** Логнормальное: exp(N(mu, sigma)). mu и sigma — параметры ЛОГАРИФМА. */
    lognormal(mu, sigma) {
      return Math.exp(normal(mu, sigma));
    },

    /** Истина с вероятностью p. */
    bool(p = 0.5) {
      return float() < p;
    },

    /**
     * Выбор элемента. Без weights — равномерно.
     * С weights — пропорционально весам (веса не обязаны быть нормированы,
     * отрицательные считаются нулём).
     */
    pick(arr, weights) {
      if (!arr || arr.length === 0) return undefined;
      if (!weights) return arr[Math.floor(float() * arr.length)];

      let total = 0;
      for (let i = 0; i < arr.length; i++) total += Math.max(0, weights[i] || 0);
      if (total <= 0) return arr[Math.floor(float() * arr.length)];

      let r = float() * total;
      for (let i = 0; i < arr.length; i++) {
        r -= Math.max(0, weights[i] || 0);
        if (r < 0) return arr[i];
      }
      return arr[arr.length - 1]; // страховка от накопленной ошибки float
    },

    /** Перемешивание Фишера—Йетса. Возвращает КОПИЮ: вход не мутируем. */
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(float() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },

    /**
     * Независимый поток, детерминированно выведенный из текущего seed.
     * Нужен, чтобы Монте-Карло на 500 прогонов не сдвигал основной поток:
     * rng.fork(k) даёт k-й воспроизводимый сценарий.
     */
    fork(sub) {
      return makeRng(hashSeed(`${initial}:${sub}`));
    },
  };

  return rng;
}

/**
 * Ту же функцию хеширования отдаём наружу — ей удобно собирать
 * составные seed'ы («коридор + день») без коллизий.
 */
export { hashSeed };
