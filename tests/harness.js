// =====================================================================
//  TOLYQ — МИНИМАЛЬНЫЙ ТЕСТОВЫЙ ХАРНЕСС
// ---------------------------------------------------------------------
//  Внешних библиотек в проекте нет по условию, поэтому раннер свой.
//  Одни и те же тест-модули запускаются в двух средах:
//    node tests/run.js            — если node установлен;
//    tests/run.html через         — python3 -m http.server 8000
//                                   http://localhost:8000/tests/run.html
//  Вторая среда важнее: на защите гарантированно есть браузер,
//  а node может не быть.
// =====================================================================

const suites = [];
let current = null;

/** Объявить группу тестов. */
export function suite(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

/** Объявить тест внутри группы. */
export function test(name, fn) {
  if (!current) throw new Error('test() вызван вне suite()');
  current.tests.push({ name, fn });
}

// ---------------------------------------------------------------------
//  ПРОВЕРКИ
// ---------------------------------------------------------------------

export function assert(cond, msg = 'ожидалась истина') {
  if (!cond) throw new Error(msg);
}

export function equal(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n  получено: ${fmt(actual)}\n  ожидалось: ${fmt(expected)}`);
  }
}

/** Сравнение чисел с допуском — иначе на float-арифметике тесты врут. */
export function close(actual, expected, eps = 1e-6, msg = '') {
  if (!(Math.abs(actual - expected) <= eps)) {
    throw new Error(`${msg}\n  получено: ${fmt(actual)}\n  ожидалось: ${fmt(expected)} ± ${eps}`);
  }
}

export function lessOrEqual(a, b, msg = '') {
  if (!(a <= b)) throw new Error(`${msg}\n  ${fmt(a)} должно быть <= ${fmt(b)}`);
}

export function greaterOrEqual(a, b, msg = '') {
  if (!(a >= b)) throw new Error(`${msg}\n  ${fmt(a)} должно быть >= ${fmt(b)}`);
}

export function throws(fn, msg = 'ожидалось исключение') {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(msg);
}

function fmt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(6);
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}

// ---------------------------------------------------------------------
//  ЗАПУСК
// ---------------------------------------------------------------------

/**
 * Прогоняет всё объявленное. Печатает отчёт через переданный write().
 * @param {(line:string, kind?:string)=>void} write
 * @returns {{passed:number, failed:number, ms:number}}
 */
export function run(write = (l) => console.log(l)) {
  let passed = 0;
  let failed = 0;
  const t0 = now();

  for (const s of suites) {
    write(`\n■ ${s.name}`, 'suite');
    for (const t of s.tests) {
      const tt = now();
      try {
        t.fn();
        const ms = now() - tt;
        passed++;
        write(`  ✓ ${t.name}${ms > 20 ? ` (${ms.toFixed(0)} мс)` : ''}`, 'pass');
      } catch (err) {
        failed++;
        write(`  ✗ ${t.name}`, 'fail');
        write(`      ${String(err && err.message || err).replace(/\n/g, '\n      ')}`, 'fail');
      }
    }
  }

  const ms = now() - t0;
  write(
    `\n${failed === 0 ? 'ВСЁ ЗЕЛЁНОЕ' : 'ЕСТЬ ПАДЕНИЯ'}: ${passed} прошло, ${failed} упало, ${ms.toFixed(0)} мс`,
    failed === 0 ? 'pass' : 'fail'
  );
  return { passed, failed, ms };
}

function now() {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
