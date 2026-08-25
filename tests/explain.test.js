// Тесты слоя LLM. Главное, что здесь проверяется, — что его отсутствие
// НИКАК не мешает продукту: все тесты идут без ключа и без сети.
import { suite, test, assert, equal, lessOrEqual, greaterOrEqual } from './harness.js';
import {
  parseRequestOffline,
  parseRequestSync,
  parseRequest,
  explainOffline,
  explainSolutionSync,
  explainSolution,
  isLlmAvailable,
  getApiKey,
  LLM_KEY_NAME,
} from '../src/core/explain.js';
import { solve } from '../src/core/solve.js';
import { m3PerTon } from '../src/core/network.js';

/** Фиксированная опорная дата: иначе «до четверга» недетерминирован. */
const MONDAY = new Date('2026-08-24T09:00:00');

suite('explain.js — оффлайн-разбор текста', () => {
  test('разбирает эталонную фразу из задания', () => {
    const r = parseRequestOffline('надо отвезти 8 тонн муки из Астаны в Алматы до четверга', MONDAY);
    assert(r, 'фраза должна разбираться без всякой сети');
    equal(r.from, 'AST');
    equal(r.to, 'ALA');
    equal(r.tons, 8);
    equal(r.cargoType, 'food', 'мука — это продукты');
    assert(r.deadlineH > 0 && r.deadlineH < 168, `странный дедлайн ${r.deadlineH}`);
    equal(r.source, 'offline');
  });

  test('объём считается по плотности определённого типа груза', () => {
    const r = parseRequestOffline('12 тонн муки из Астаны в Шымкент', MONDAY);
    equal(r.cargoType, 'food');
    equal(r.volumeM3, Math.round(12 * m3PerTon('food') * 10) / 10);
  });

  test('понимает направление по предлогам, а не по порядку слов', () => {
    const r = parseRequestOffline('в Алматы из Астаны нужно 5 тонн', MONDAY);
    equal(r.from, 'AST', 'предлог «из» должен определять отправление');
    equal(r.to, 'ALA');
  });

  test('без предлогов берёт порядок упоминания', () => {
    const r = parseRequestOffline('Караганда Павлодар 6 тонн', MONDAY);
    equal(r.from, 'KGF');
    equal(r.to, 'PWQ');
  });

  test('понимает города в косвенных падежах', () => {
    equal(parseRequestOffline('7 т из Актобе в Атырау', MONDAY).from, 'AKX');
    equal(parseRequestOffline('7 т из Актобе в Атырау', MONDAY).to, 'ATX');
    equal(parseRequestOffline('3 тонны из Костаная в Тараз', MONDAY).from, 'KSN');
    equal(parseRequestOffline('9 тонн из Шымкента в Актау', MONDAY).to, 'SCO');
  });

  test('различает типы груза по ключевым словам', () => {
    equal(parseRequestOffline('10 т зерна из Астаны в Актау', MONDAY).cargoType, 'food');
    equal(parseRequestOffline('10 т удобрений из Астаны в Актау', MONDAY).cargoType, 'chemical');
    equal(parseRequestOffline('10 т запчастей из Астаны в Актау', MONDAY).cargoType, 'general');
    equal(parseRequestOffline('10 т из Астаны в Актау', MONDAY).cargoType, 'general', 'по умолчанию генгруз');
  });

  test('буква ё не мешает разбору', () => {
    equal(parseRequestOffline('5 т щёлочи из Астаны в Алматы', MONDAY).cargoType, 'chemical');
  });

  test('понимает массу в тоннах и в килограммах', () => {
    equal(parseRequestOffline('8 тонн из Астаны в Алматы', MONDAY).tons, 8);
    equal(parseRequestOffline('8,5 т из Астаны в Алматы', MONDAY).tons, 8.5);
    equal(parseRequestOffline('12000 кг из Астаны в Алматы', MONDAY).tons, 12);
  });

  test('понимает разные формы срока', () => {
    equal(parseRequestOffline('8 т из Астаны в Алматы за 3 дня', MONDAY).deadlineH, 72);
    equal(parseRequestOffline('8 т из Астаны в Алматы через 48 часов', MONDAY).deadlineH, 48);
    equal(parseRequestOffline('8 т из Астаны в Алматы завтра', MONDAY).deadlineH, 24);
    equal(parseRequestOffline('8 т из Астаны в Алматы за неделю', MONDAY).deadlineH, 168);
    equal(parseRequestOffline('8 т из Астаны в Алматы', MONDAY).deadlineH, 96, 'без срока — умолчание');
  });

  test('«до четверга» считается от опорной даты', () => {
    // MONDAY — понедельник, до четверга 18:00 примерно 81 час
    const r = parseRequestOffline('8 т из Астаны в Алматы до четверга', MONDAY);
    greaterOrEqual(r.deadlineH, 70);
    lessOrEqual(r.deadlineH, 90);
  });

  test('неразбираемый текст даёт null, а не полуфабрикат', () => {
    // UI лучше показать пустую форму, чем форму с угаданными наполовину полями
    equal(parseRequestOffline('привет как дела', MONDAY), null);
    equal(parseRequestOffline('8 тонн', MONDAY), null, 'без городов разбирать нечего');
    equal(parseRequestOffline('из Астаны в Алматы', MONDAY), null, 'без массы разбирать нечего');
    equal(parseRequestOffline('', MONDAY), null);
    equal(parseRequestOffline(null, MONDAY), null);
    equal(parseRequestOffline(undefined, MONDAY), null);
    equal(parseRequestOffline(42, MONDAY), null);
  });

  test('один и тот же город с обеих сторон отбрасывается', () => {
    equal(parseRequestOffline('8 т из Астаны в Астану', MONDAY), null);
  });

  test('нелепая масса отбрасывается', () => {
    equal(parseRequestOffline('0 тонн из Астаны в Алматы', MONDAY), null);
    equal(parseRequestOffline('99999 тонн из Астаны в Алматы', MONDAY), null);
  });

  test('результат разбора принимается движком', () => {
    const r = parseRequestOffline('надо отвезти 8 тонн муки из Астаны в Алматы до четверга', MONDAY);
    const s = solve(r);
    assert(s.recommended, 'движок должен решить разобранную заявку');
    equal(s.request.from, 'AST');
    equal(s.request.cargoType, 'food');
  });

  test('parseRequestSync идентичен оффлайн-разбору', () => {
    const a = parseRequestSync('8 т муки из Астаны в Алматы', MONDAY);
    const b = parseRequestOffline('8 т муки из Астаны в Алматы', MONDAY);
    equal(JSON.stringify(a), JSON.stringify(b));
  });
});

suite('explain.js — объяснение без сети', () => {
  const sol = solve({ from: 'AST', to: 'ALA', tons: 8, cargoType: 'general', deadlineH: 96 });

  test('шаблонное объяснение содержательно и на русском', () => {
    const text = explainOffline(sol);
    equal(typeof text, 'string');
    greaterOrEqual(text.length, 60, 'объяснение слишком короткое');
    assert(/[а-я]/i.test(text), 'объяснение должно быть на русском');
  });

  test('объяснение опирается на числа из решения', () => {
    const text = explainOffline(sol);
    assert(text.includes(sol.recommended.label), 'должен быть назван рекомендованный маршрут');
    assert(/\d/.test(text), 'в объяснении должны быть числа');
  });

  test('объяснение упоминает час отправки, когда политика невырождена', () => {
    assert(!sol.stopping.degenerate, 'для этой заявки политика должна быть содержательной');
    assert(
      explainOffline(sol).includes(`${sol.stopping.dispatchAtH}`),
      'рекомендованный час отправки должен попасть в объяснение'
    );
  });

  test('пустое решение объясняется, а не роняет', () => {
    const empty = solve({ from: 'AST', to: 'НЕТУ', tons: 8 });
    const text = explainOffline(empty);
    assert(text.includes('не найден'), 'причина должна быть названа');
  });

  test('null и мусор на входе не роняют', () => {
    assert(typeof explainOffline(null) === 'string');
    assert(typeof explainOffline({}) === 'string');
    assert(typeof explainOffline({ recommended: null }) === 'string');
  });

  test('explainSolutionSync идентичен откату', () => {
    equal(explainSolutionSync(sol), explainOffline(sol));
  });

  test('вырожденная политика объясняется своей причиной', () => {
    const heavy = solve({ from: 'AST', to: 'ALA', tons: 200, volumeM3: 400, deadlineH: 300 });
    const text = explainOffline(heavy);
    assert(text.length > 40);
    assert(/[а-я]/i.test(text));
  });
});

suite('explain.js — деградация без ключа', () => {
  test('без ключа слой LLM объявлен недоступным', () => {
    // Ключ в тестовой среде не выставляем — проверяем именно этот путь
    if (getApiKey() === null) {
      equal(isLlmAvailable(), false, 'без ключа слой должен быть выключен');
    }
  });

  test('getApiKey не бросает исключение ни при каких обстоятельствах', () => {
    const v = getApiKey();
    assert(v === null || typeof v === 'string');
  });

  test('имя ключа не выглядит как сам ключ', () => {
    equal(LLM_KEY_NAME, 'TOLYQ_LLM_KEY');
    assert(!/sk-|api[-_]?key\s*=/i.test(LLM_KEY_NAME), 'в репозитории не должно быть секретов');
  });

  test('parseRequest без ключа отдаёт результат оффлайн-разбора', async () => {
    const r = await parseRequest('8 тонн муки из Астаны в Алматы', { now: MONDAY });
    assert(r, 'должен сработать оффлайн-путь');
    equal(r.from, 'AST');
    equal(r.source, 'offline');
  });

  test('parseRequest без ключа на мусоре отдаёт null', async () => {
    equal(await parseRequest('привет', { now: MONDAY }), null);
  });

  test('explainSolution без ключа возвращает шаблонную фразу', async () => {
    const s = solve({ from: 'AST', to: 'ALA', tons: 8, deadlineH: 96 });
    const text = await explainSolution(s);
    equal(text, explainOffline(s), 'без ключа результат обязан совпасть с откатом');
  });

  test('explainSolution всегда возвращает строку, даже на пустом решении', async () => {
    const text = await explainSolution(solve({ from: 'AST', to: 'НЕТУ', tons: 8 }));
    equal(typeof text, 'string');
    assert(text.length > 10);
  });
});
