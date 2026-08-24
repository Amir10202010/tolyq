// Тесты многокритериального поиска: доминирование, полнота фронта,
// вырожденные случаи, производительность.
import { suite, test, assert, equal, close, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  paretoRoutes,
  pickByWeights,
  dominates,
  normalizeWeights,
  wagonShare,
  wagonsNeeded,
  MAX_TRANSSHIPMENTS,
} from '../src/core/pareto.js';
import { isHub, WAGON_CAP_T } from '../src/core/network.js';

/** Типовая заявка: 8 тонн — тот самый случай, ради которого всё затевалось. */
const req = (over = {}) => ({
  from: 'AST',
  to: 'ALA',
  tons: 8,
  volumeM3: 52,
  cargoType: 'general',
  deadlineH: 96,
  ...over,
});

suite('pareto.js — доминирование', () => {
  test('строго лучший по всем критериям доминирует', () => {
    assert(dominates({ cost: 1, hours: 1, co2: 1 }, { cost: 2, hours: 2, co2: 2 }));
  });

  test('равный по всем критериям НЕ доминирует', () => {
    assert(!dominates({ cost: 1, hours: 1, co2: 1 }, { cost: 1, hours: 1, co2: 1 }));
  });

  test('лучше по одному, хуже по другому — не доминирует ни в одну сторону', () => {
    const a = { cost: 1, hours: 5, co2: 3 };
    const b = { cost: 5, hours: 1, co2: 3 };
    assert(!dominates(a, b), 'a не должен доминировать b');
    assert(!dominates(b, a), 'b не должен доминировать a');
  });

  test('не хуже по всем и строго лучше по одному — доминирует', () => {
    assert(dominates({ cost: 1, hours: 2, co2: 3 }, { cost: 1, hours: 2, co2: 4 }));
  });

  test('перегрузки — четвёртый критерий: метка с меньшим числом не вытесняется', () => {
    const a = { cost: 1, hours: 1, co2: 1, transship: 2 };
    const b = { cost: 1, hours: 1, co2: 1, transship: 0 };
    assert(!dominates(a, b), 'дорогая по ресурсу метка не должна вытеснять экономную');
    assert(dominates(b, a), 'экономная по перегрузкам должна доминировать');
  });

  test('доминирование транзитивно на тройке', () => {
    const a = { cost: 1, hours: 1, co2: 1 };
    const b = { cost: 2, hours: 2, co2: 2 };
    const c = { cost: 3, hours: 3, co2: 3 };
    assert(dominates(a, b) && dominates(b, c) && dominates(a, c));
  });
});

suite('pareto.js — фронт на реальной сети', () => {
  test('прямое плечо Астана→Караганда: во фронте есть и фура, и ЖД', () => {
    const { pareto } = paretoRoutes('AST', 'KGF', req({ to: 'KGF' }));
    const road = pareto.find((r) => r.label === 'Только фура');
    const rail = pareto.find((r) => r.label === 'Только ЖД');
    assert(road, 'автомобильный вариант обязан быть во фронте');
    assert(rail, 'железнодорожный вариант обязан быть во фронте');
    // Ни один не должен доминировать другой: это разные компромиссы
    assert(road.hours < rail.hours, 'фура должна быть быстрее');
    assert(rail.costKzt < road.costKzt, 'доля вагона должна быть дешевле фуры');
    assert(rail.co2Kg < road.co2Kg, 'ЖД должна быть чище');
  });

  test('фронт внутренне недоминируем', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    for (const a of pareto) {
      for (const b of pareto) {
        if (a === b) continue;
        assert(
          !dominates(
            { cost: a.costKzt, hours: a.hours, co2: a.co2Kg, transship: a.transshipments },
            { cost: b.costKzt, hours: b.hours, co2: b.co2Kg, transship: b.transshipments }
          ),
          `во фронте маршрут ${a.label} доминирует ${b.label}`
        );
      }
    }
  });

  test('каждый отброшенный маршрут действительно кем-то доминируется', () => {
    const { pareto, dominated } = paretoRoutes('AST', 'ALA', req());
    for (const d of dominated) {
      const killer = pareto.some((p) =>
        dominates(
          { cost: p.costKzt, hours: p.hours, co2: p.co2Kg, transship: p.transshipments },
          { cost: d.costKzt, hours: d.hours, co2: d.co2Kg, transship: d.transshipments }
        )
      );
      assert(killer, `маршрут ${d.label} отброшен, но его никто не доминирует`);
    }
  });

  test('фронт непустой на всех парах узлов', () => {
    const ids = ['AST', 'ALA', 'SHY', 'KGF', 'AKX', 'ATX', 'KSN', 'PWQ', 'DMB', 'SCO', 'KHG', 'DOS'];
    for (const a of ids) {
      for (const b of ids) {
        if (a === b) continue;
        const { pareto } = paretoRoutes(a, b, req({ from: a, to: b, deadlineH: 1000 }));
        greaterOrEqual(pareto.length, 1, `пустой фронт для ${a}→${b}`);
      }
    }
  });

  test('перегрузки только в хабах и не больше лимита', () => {
    const { pareto, dominated } = paretoRoutes('AST', 'SCO', req({ to: 'SCO', deadlineH: 400 }));
    for (const r of pareto.concat(dominated)) {
      lessOrEqual(r.transshipments, MAX_TRANSSHIPMENTS, `перебор перегрузок в ${r.label}`);
      for (const leg of r.legs) {
        if (leg.transshipment) assert(isHub(leg.from), `перегрузка в не-хабе ${leg.from}`);
      }
    }
  });

  test('участки маршрута образуют непрерывную цепочку', () => {
    const { pareto } = paretoRoutes('AST', 'SCO', req({ to: 'SCO', deadlineH: 400 }));
    for (const r of pareto) {
      equal(r.legs[0].from, 'AST', 'маршрут должен начинаться в источнике');
      equal(r.legs[r.legs.length - 1].to, 'SCO', 'маршрут должен кончаться в цели');
      for (let i = 1; i < r.legs.length; i++) {
        equal(r.legs[i].from, r.legs[i - 1].to, 'разрыв в цепочке участков');
      }
    }
  });

  test('суммы по участкам сходятся с итогом маршрута', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    for (const r of pareto) {
      const cost = r.legs.reduce((s, l) => s + l.costKzt, 0);
      const co2 = r.legs.reduce((s, l) => s + l.co2Kg, 0);
      close(cost, r.costKzt, 3, `стоимость участков ≠ итогу в ${r.label}`);
      close(co2, r.co2Kg, 1, `выбросы участков ≠ итогу в ${r.label}`);
    }
  });

  test('маршрут не проходит один узел дважды', () => {
    const { pareto } = paretoRoutes('AST', 'SCO', req({ to: 'SCO', deadlineH: 400 }));
    for (const r of pareto) {
      const nodes = [r.legs[0].from, ...r.legs.map((l) => l.to)];
      equal(new Set(nodes).size, nodes.length, `цикл в маршруте ${r.label}`);
    }
  });
});

suite('pareto.js — вырожденные случаи', () => {
  test('несуществующий узел: пустой фронт, а не исключение', () => {
    const r = paretoRoutes('AST', 'НЕТ_ТАКОГО', req());
    equal(r.pareto.length, 0, 'фронт должен быть пуст');
    equal(r.dominated.length, 0, 'отброшенных тоже быть не должно');
  });

  test('несуществующий источник обрабатывается так же', () => {
    equal(paretoRoutes('НЕТ', 'ALA', req()).pareto.length, 0);
  });

  test('источник совпадает с целью: пустой фронт без падения', () => {
    equal(paretoRoutes('AST', 'AST', req()).pareto.length, 0);
  });

  test('дедлайн меньше времени в пути: возвращаем варианты, помеченные невыполнимыми', () => {
    const res = paretoRoutes('AST', 'ALA', req({ deadlineH: 2 }));
    greaterOrEqual(res.pareto.length, 1, 'нельзя отдавать пустоту — покажем ближайшее');
    assert(res.stats.deadlineInfeasible, 'должен быть выставлен флаг невыполнимости');
    for (const r of res.pareto) equal(r.feasible, false, 'все варианты должны быть infeasible');
  });

  test('реальный дедлайн: feasible выставлен согласованно с часами', () => {
    const res = paretoRoutes('AST', 'ALA', req({ deadlineH: 40 }));
    for (const r of res.pareto) equal(r.feasible, r.hours <= 40, `feasible у ${r.label}`);
  });

  test('груз тяжелее вагона: считаем несколько вагонов, а не долю', () => {
    equal(wagonsNeeded(150, 0), 3, '150 т — три вагона');
    equal(wagonShare(150, 0), 3, 'делить нечего, платим за три вагона');
    const { pareto } = paretoRoutes('AST', 'KGF', req({ to: 'KGF', tons: 150, volumeM3: 300 }));
    greaterOrEqual(pareto.length, 1, 'тяжёлая партия всё равно должна маршрутизироваться');
  });

  test('доля вагона не опускается ниже минимальной тарифицируемой', () => {
    greaterOrEqual(wagonShare(0.1, 0), 0.15, 'слишком дешёвая доля — тариф так не работает');
    lessOrEqual(wagonShare(WAGON_CAP_T, 0), 1, 'доля не может быть больше вагона');
  });

  test('нулевая партия не роняет поиск', () => {
    const res = paretoRoutes('AST', 'KGF', req({ to: 'KGF', tons: 0, volumeM3: 0 }));
    greaterOrEqual(res.pareto.length, 1);
  });
});

suite('pareto.js — выбор по весам', () => {
  test('вес на стоимость выбирает самый дешёвый маршрут фронта', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    const best = pickByWeights(pareto, { cost: 1, time: 0, co2: 0 });
    const cheapest = pareto.reduce((a, b) => (a.costKzt <= b.costKzt ? a : b));
    equal(best.costKzt, cheapest.costKzt, 'при весе только на деньги должен победить дешёвый');
  });

  test('вес на время выбирает самый быстрый', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    const best = pickByWeights(pareto, { cost: 0, time: 1, co2: 0 });
    const fastest = pareto.reduce((a, b) => (a.hours <= b.hours ? a : b));
    equal(best.hours, fastest.hours);
  });

  test('вес на экологию выбирает самый чистый', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    const best = pickByWeights(pareto, { cost: 0, time: 0, co2: 1 });
    const cleanest = pareto.reduce((a, b) => (a.co2Kg <= b.co2Kg ? a : b));
    equal(best.co2Kg, cleanest.co2Kg);
  });

  test('пустой список — null, единственный элемент — он сам', () => {
    equal(pickByWeights([], { cost: 1 }), null);
    const one = [{ costKzt: 1, hours: 1, co2Kg: 1 }];
    equal(pickByWeights(one, { cost: 1 }), one[0]);
  });

  test('нулевые веса не роняют выбор — приоритеты равные', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    assert(pickByWeights(pareto, { cost: 0, time: 0, co2: 0 }) !== null);
    const w = normalizeWeights({});
    close(w.cost + w.time + w.co2, 1, 1e-9, 'веса должны нормироваться в сумму 1');
  });

  test('веса нормируются, масштаб не влияет на результат', () => {
    const { pareto } = paretoRoutes('AST', 'ALA', req());
    const a = pickByWeights(pareto, { cost: 2, time: 1, co2: 1 });
    const b = pickByWeights(pareto, { cost: 20, time: 10, co2: 10 });
    equal(a.id, b.id, 'умножение весов на константу не должно менять выбор');
  });
});

suite('pareto.js — производительность', () => {
  test('самая длинная пара считается меньше 150 мс', () => {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    paretoRoutes('DOS', 'SCO', req({ from: 'DOS', to: 'SCO', deadlineH: 500 }));
    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    lessOrEqual(ms, 150, `поиск занял ${ms.toFixed(0)} мс — не влезаем в бюджет solve()`);
  });

  test('потолок меток соблюдается', () => {
    const { stats } = paretoRoutes('DOS', 'SCO', req({ from: 'DOS', to: 'SCO', deadlineH: 500 }));
    lessOrEqual(stats.expanded, 5000, 'превышен потолок обработанных меток');
  });
});
