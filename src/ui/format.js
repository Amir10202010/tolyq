// =====================================================================
//  TOLYQ / UI — форматирование чисел под русскую типографику
// ---------------------------------------------------------------------
//  Единственное место, где числа превращаются в строки. Если где-то в
//  интерфейсе видна «сырая» цифра — это ошибка, её сюда.
// =====================================================================

const NBSP  = ' ';  // неразрывный пробел — разряды не должны рваться
const NDASH = '–';
const MDASH = '—';

/** Разряды неразрывными пробелами: 390400 -> "390 400" */
export function num(v, digits = 0) {
  if (v == null || !isFinite(v)) return String.fromCharCode(0x2014);
  const fixed = Math.abs(v).toFixed(digits);
  const [int, frac] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const sign = v < 0 ? '−' : '';
  return sign + grouped + (frac ? ',' + frac : '');
}

/** Тенге. short=true сжимает до «390 тыс» / «28,6 млн» для крупных чисел. */
export function kzt(v, { short = false, sign = false, symbol = true } = {}) {
  const s = sign && v > 0 ? '+' : '';
  const tail = symbol ? NBSP + '₸' : '';
  if (!short) return s + num(Math.round(v)) + tail;
  const a = Math.abs(v);
  if (a >= 1e9) return s + num(v / 1e9, 1) + NBSP + 'млрд' + tail;
  if (a >= 1e6) return s + num(v / 1e6, 1) + NBSP + 'млн'  + tail;
  if (a >= 1e4) return s + num(v / 1e3, 0) + NBSP + 'тыс'  + tail;
  return s + num(Math.round(v)) + tail;
}

/** Короткая запись часов для таблиц и осей: 46 -> "46 ч", 3.5 -> "3,5 ч" */
export function hoursShort(h) {
  if (h == null || !isFinite(h)) return MDASH;
  const rounded = Math.abs(h - Math.round(h)) < 0.05 ? Math.round(h) : h;
  return num(rounded, Number.isInteger(rounded) ? 0 : 1) + NBSP + 'ч';
}

/** Человеческая запись: 46 -> "1 сут 22 ч", 3.5 -> "3 ч 30 мин" */
export function hoursHuman(h) {
  if (h == null || !isFinite(h)) return MDASH;
  const total = Math.round(h * 60);
  const d = Math.floor(total / 1440);
  const hh = Math.floor((total - d * 1440) / 60);
  const mm = total % 60;
  const parts = [];
  if (d)  parts.push(d + NBSP + 'сут');
  if (hh) parts.push(hh + NBSP + 'ч');
  if (mm && !d) parts.push(mm + NBSP + 'мин');
  return parts.join(' ') || '0' + NBSP + 'ч';
}

export function tons(t, digits = 0) { return num(t, digits) + NBSP + 'т'; }
export function km(v)               { return num(Math.round(v)) + NBSP + 'км'; }
export function pct(v, digits = 0)  { return num(v, digits) + NBSP + '%'; }

/** CO2: до тонны — в килограммах, дальше — в тоннах */
export function co2(kg, { sign = false } = {}) {
  const s = sign && kg > 0 ? '+' : '';
  if (Math.abs(kg) >= 1000) return s + num(kg / 1000, 1) + NBSP + 'т';
  return s + num(Math.round(kg)) + NBSP + 'кг';
}

/** Склонение: plural(2, 'фура', 'фуры', 'фур') -> 'фуры' */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5)   return few;
  if (b === 1)          return one;
  return many;
}

/** «96 фур» c правильным окончанием */
export function withPlural(n, one, few, many) {
  return num(n) + NBSP + plural(n, one, few, many);
}

export const dash = { n: NDASH, m: MDASH, nbsp: NBSP };
