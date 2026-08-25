// Тесты упаковки вагона: ограничения не нарушаются никогда,
// отжиг не хуже жадного алгоритма ни на одном наборе.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  packing,
  packFFD,
  packAnneal,
  checkFeasible,
  incompatible,
  ANNEAL_ITERATIONS,
} from '../src/core/packing.js';
import { WAGON_CAP_T, WAGON_CAP_M3, m3PerTon } from '../src/core/network.js';
import { makeRng } from '../src/core/random.js';
import { simulateArrivals } from '../src/core/market.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const mine = (over = {}) => ({ tons: 8, volumeM3: 20, cargoType: 'general', ...over });

/** Случайный набор заявок для стресс-проверок. */
function randomBatch(rng, n) {
  const types = ['general', 'food', 'chemical'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const tons = 2 + rng.float() * 16;
    const type = rng.pick(types, [0.6, 0.3, 0.1]);
    out.push({
      atH: rng.float() * 48,
      tons: Math.round(tons * 100) / 100,
      volumeM3: Math.round(tons * m3PerTon(type) * (0.85 + rng.float() * 0.3) * 10) / 10,
      cargoType: type,
      shipper: `ТОО «Тест ${i}»`,
      accepted: false,
    });
  }
  return out;
}

suite('packing.js — ограничения', () => {
  test('несовместимость симметрична и не задевает генгруз', () => {
    assert(incompatible('chemical', 'food'));
    assert(incompatible('food', 'chemical'));
    assert(!incompatible('general', 'food'));
    assert(!incompatible('general', 'chemical'));
    assert(!incompatible('food', 'food'));
  });

  test('checkFeasible ловит перегруз по массе', () => {
    const items = [{ tons: WAGON_CAP_T, volumeM3: 1, cargoType: 'general' }];
    const r = checkFeasible(items, mine());
    equal(r.ok, false);
    equal(r.reason, 'перегруз по массе');
  });

  test('checkFeasible ловит перегруз по объёму', () => {
    const items = [{ tons: 1, volumeM3: WAGON_CAP_M3, cargoType: 'general' }];
    const r = checkFeasible(items, mine());
    equal(r.ok, false);
    equal(r.reason, 'перегруз по объёму');
  });

  test('checkFeasible ловит химию рядом с продуктами', () => {
    const items = [
      { tons: 2, volumeM3: 4, cargoType: 'chemical' },
      { tons: 2, volumeM3: 3, cargoType: 'food' },
    ];
    const r = checkFeasible(items, mine());
    equal(r.ok, false);
    equal(r.reason, 'химия вместе с продуктами');
  });

  test('наш собственный груз участвует в проверке совместимости', () => {
    const items = [{ tons: 2, volumeM3: 3, cargoType: 'food' }];
    equal(checkFeasible(items, mine({ cargoType: 'chemical' })).ok, false);
    equal(checkFeasible(items, mine({ cargoType: 'general' })).ok, true);
  });

  test('пустой набор допустим', () => {
    equal(checkFeasible([], mine()).ok, true);
  });
});

suite('packing.js — ограничения не нарушаются никогда', () => {
  test('на 50 случайных наборах результат всегда допустим', () => {
    for (let s = 0; s < 50; s++) {
      const rng = makeRng(`feas-${s}`);
      const batch = randomBatch(rng, rng.int(3, 25));
      const my = mine({ cargoType: rng.pick(['general', 'food', 'chemical']) });
      const res = packing(batch, my, `seed-${s}`);

      const chk = checkFeasible(res.accepted, my);
      equal(chk.ok, true, `набор ${s}: ${chk.reason}`);
      lessOrEqual(chk.tons, WAGON_CAP_T + 1e-6, `набор ${s}: перегруз по массе`);
      lessOrEqual(chk.volumeM3, WAGON_CAP_M3 + 1e-6, `набор ${s}: перегруз по объёму`);
    }
  });

  test('жадный алгоритм тоже не нарушает ограничений', () => {
    for (let s = 0; s < 30; s++) {
      const rng = makeRng(`ffd-${s}`);
      const batch = randomBatch(rng, rng.int(3, 25));
      const my = mine({ cargoType: rng.pick(['general', 'food', 'chemical']) });
      const chk = checkFeasible(packFFD(batch, my).selected, my);
      equal(chk.ok, true, `набор ${s}: ${chk.reason}`);
    }
  });

  test('химия в вагоне исключает продукты и наоборот', () => {
    for (let s = 0; s < 30; s++) {
      const rng = makeRng(`compat-${s}`);
      const res = packing(randomBatch(rng, 20), mine(), `c-${s}`);
      const types = new Set(res.accepted.map((a) => a.cargoType));
      types.add('general');
      assert(!(types.has('chemical') && types.has('food')), `набор ${s}: химия рядом с продуктами`);
    }
  });

  test('наш груз всегда учтён в итоговом тоннаже', () => {
    const my = mine({ tons: 12, volumeM3: 30 });
    const res = packing(randomBatch(makeRng('own'), 10), my, 'own');
    greaterOrEqual(res.tonsTotal, my.tons - 1e-6, 'собственный груз потерялся');
  });

  test('заявки, несовместимые с нашим грузом, не попадают в кандидаты', () => {
    const batch = [
      { tons: 5, volumeM3: 8, cargoType: 'food' },
      { tons: 5, volumeM3: 10, cargoType: 'general' },
    ];
    const res = packing(batch, mine({ cargoType: 'chemical' }), 'x');
    for (const a of res.accepted) assert(a.cargoType !== 'food', 'продукты попали к химии');
  });
});

suite('packing.js — отжиг против жадного', () => {
  test('отжиг не хуже FFD ни на одном из 50 случайных наборов', () => {
    let strictlyBetter = 0;
    for (let s = 0; s < 50; s++) {
      const rng = makeRng(`anneal-${s}`);
      const batch = randomBatch(rng, rng.int(4, 30));
      const my = mine({ cargoType: rng.pick(['general', 'food', 'chemical']) });

      const res = packing(batch, my, `a-${s}`);
      greaterOrEqual(
        res.fillPct,
        res.baselineFillPct - 1e-9,
        `набор ${s}: отжиг хуже жадного (${res.fillPct} против ${res.baselineFillPct})`
      );
      if (res.fillPct > res.baselineFillPct + 1e-9) strictlyBetter++;
    }
    // Если отжиг никогда не улучшает базу — он бесполезен и это тоже баг
    greaterOrEqual(strictlyBetter, 1, 'отжиг ни разу не улучшил жадное решение');
  });

  test('gainPp — разность долей, измеренных ОДИНАКОВО и по тоннажу', () => {
    // Именно это число UI показывает как «отжиг дал +N пунктов».
    // Мера — тоннаж, то есть ровно то, что отжиг максимизирует.
    for (let s = 0; s < 20; s++) {
      const res = packing(randomBatch(makeRng(`gain-${s}`), 20), mine(), `g-${s}`);
      close(res.gainPp, res.fillPct - res.baselineFillPct, 0.2, `набор ${s}: выигрыш не сходится с долями`);
      greaterOrEqual(res.gainPp, -1e-9, `набор ${s}: выигрыш отрицателен`);
      lessOrEqual(res.fillPct, 100, 'загрузка выше 100 % невозможна');
      lessOrEqual(res.baselineFillPct, 100, 'базовая загрузка выше 100 % невозможна');
      lessOrEqual(res.volumeFillPct, 100, 'занятость по объёму выше 100 % невозможна');
      equal(
        res.limitingFillPct,
        Math.max(res.fillPct, res.volumeFillPct),
        'лимитирующая доля должна быть максимумом из массовой и объёмной'
      );
    }
  });

  test('поле limitedBy называет ресурс, который кончился первым', () => {
    for (let s = 0; s < 20; s++) {
      const res = packing(randomBatch(makeRng(`lim-${s}`), 20), mine(), `l-${s}`);
      equal(
        res.limitedBy,
        res.volumeFillPct > res.fillPct ? 'объём' : 'масса',
        `набор ${s}: ресурс назван неверно`
      );
    }
  });

  test('результат воспроизводим при одном seed', () => {
    const batch = randomBatch(makeRng('repro'), 20);
    const a = packing(batch, mine(), 'same');
    const b = packing(batch, mine(), 'same');
    equal(a.tonsTotal, b.tonsTotal);
    equal(JSON.stringify(a.accepted.map((x) => x.shipper)), JSON.stringify(b.accepted.map((x) => x.shipper)));
  });

  test('больше итераций — не хуже результат', () => {
    const batch = randomBatch(makeRng('iters'), 25);
    const short = packAnneal(batch, mine(), 'it', { iterations: 200 });
    const long = packAnneal(batch, mine(), 'it', { iterations: 6000 });
    greaterOrEqual(long.tonsTotal, short.baselineTonsT - 1e-9, 'длинный прогон ушёл ниже базы');
  });

  test('число итераций отражено в отчёте', () => {
    const res = packAnneal(randomBatch(makeRng('rep'), 10), mine(), 'r', { iterations: 500 });
    equal(res.iterations, 500);
  });

  test('вход не мутируется', () => {
    const batch = randomBatch(makeRng('mut'), 15);
    const before = JSON.stringify(batch);
    packing(batch, mine(), 'm');
    equal(JSON.stringify(batch), before, 'упаковка изменила исходные заявки');
  });

  test('accepted и rejected вместе покрывают всех кандидатов без пересечений', () => {
    const batch = randomBatch(makeRng('cover'), 20);
    const my = mine();
    const res = packing(batch, my, 'cov');
    const usable = batch.filter((a) => !incompatible(my.cargoType, a.cargoType));
    equal(res.accepted.length + res.rejected.length, usable.length, 'кандидаты потерялись');
    for (const a of res.accepted) equal(a.accepted, true);
    for (const r of res.rejected) equal(r.accepted, false);
  });
});

suite('packing.js — вырожденные случаи', () => {
  test('пустой поток заявок', () => {
    const res = packing([], mine(), 'empty');
    equal(res.accepted.length, 0);
    equal(res.rejected.length, 0);
    close(res.tonsTotal, 8, 1e-6, 'наш груз должен остаться');
    assert(Number.isFinite(res.fillPct));
  });

  test('без собственного груза не падает', () => {
    const res = packing(randomBatch(makeRng('nomine'), 10), null, 'n');
    assert(Number.isFinite(res.tonsTotal));
    equal(checkFeasible(res.accepted, null).ok, true);
  });

  test('одна заявка тяжелее вагона просто отвергается', () => {
    const res = packing([{ tons: 200, volumeM3: 400, cargoType: 'general' }], mine(), 'big');
    equal(res.accepted.length, 0, 'неподъёмная партия не должна попасть в вагон');
    equal(res.rejected.length, 1);
  });

  test('наш груз уже занимает весь вагон — попутка не берётся', () => {
    const my = mine({ tons: WAGON_CAP_T, volumeM3: WAGON_CAP_M3 });
    const res = packing(randomBatch(makeRng('full'), 10), my, 'f');
    equal(res.accepted.length, 0);
    equal(checkFeasible(res.accepted, my).ok, true);
  });

  test('заявки с нулевой массой отфильтровываются', () => {
    const res = packing([{ tons: 0, volumeM3: 0, cargoType: 'general' }], mine(), 'z');
    equal(res.accepted.length + res.rejected.length, 0);
  });

  test('ноль итераций отдаёт решение FFD без падения', () => {
    const batch = randomBatch(makeRng('zero'), 15);
    const res = packAnneal(batch, mine(), 'z0', { iterations: 0 });
    close(res.tonsTotal, res.baselineTonsT, 1e-6, 'без итераций должно остаться жадное решение');
  });

  test('работает на реальном потоке из market.js', () => {
    const arrivals = simulateArrivals({ from: 'AST', to: 'ALA' }, 48, 'real');
    const res = packing(arrivals, mine(), 'real');
    equal(checkFeasible(res.accepted, mine()).ok, true);
    greaterOrEqual(res.fillPct, 0);
    lessOrEqual(res.fillPct, 100);
  });
});

suite('packing.js — производительность', () => {
  test(`${ANNEAL_ITERATIONS} итераций на 30 заявках укладываются в 100 мс`, () => {
    const batch = randomBatch(makeRng('perf'), 30);
    const t0 = now();
    packing(batch, mine(), 'p');
    const ms = now() - t0;
    lessOrEqual(ms, 100, `отжиг занял ${ms.toFixed(0)} мс — solve() не влезет в бюджет`);
  });
});
