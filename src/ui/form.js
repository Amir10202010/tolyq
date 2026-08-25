// =====================================================================
//  TOLYQ / UI — ЗАЯВКА
// ---------------------------------------------------------------------
//  Форма ничего не считает. Она только собирает ShipmentRequest и зовёт
//  onChange. Все ползунки живые: кнопки «рассчитать» нет и не будет.
// =====================================================================

import { NODES, CARGO_TYPES } from '../core/types.js';
import { parseRequest } from './explain.js';
import { toast } from './toast.js';

const WEIGHT_KEYS = ['cost', 'time', 'co2'];
const PARSE_DEBOUNCE_MS = 650;
const HIGHLIGHT_MS = 2500;

export function createForm(root, { initial, onChange }) {
  const el = sel => root.querySelector(sel);

  const fields = {
    from:      el('#f-from'),
    to:        el('#f-to'),
    tons:      el('#f-tons'),
    volumeM3:  el('#f-volume'),
    deadlineH: el('#f-deadline'),
  };
  const cargoBox = el('#f-cargo');
  const sliders  = Object.fromEntries(WEIGHT_KEYS.map(k => [k, el('#w-' + k)]));
  const outputs  = Object.fromEntries(WEIGHT_KEYS.map(
    k => [k, root.querySelector(`.weight[data-key="${k}"] .weight__value`)]));

  // --- заполняем справочники -----------------------------------------
  for (const key of ['from', 'to']) {
    fields[key].innerHTML = NODES
      .map(n => `<option value="${n.id}">${n.name}</option>`)
      .join('');
  }

  cargoBox.innerHTML = Object.entries(CARGO_TYPES).map(([id, name], i) => `
    <label class="segment__item">
      <input type="radio" name="cargoType" value="${id}"${i === 0 ? ' checked' : ''}>
      <span>${shortCargo(name)}</span>
    </label>`).join('');

  // --- начальные значения --------------------------------------------
  apply(initial);

  // --- подписки -------------------------------------------------------
  for (const [key, node] of Object.entries(fields)) {
    node.addEventListener('input', () => emit());
    node.addEventListener('change', () => emit());
  }
  cargoBox.addEventListener('change', () => emit());

  for (const key of WEIGHT_KEYS) {
    sliders[key].addEventListener('input', () => {
      balance(key, Number(sliders[key].value));
      paintWeights();
      emit();
    });
  }

  // --- свободный ввод -------------------------------------------------
  const free = el('#f-free');
  let parseTimer = null;
  let parseSeq = 0;                    // защита от гонки медленных ответов
  let lastParsed = '';                 // не разбираем один и тот же текст дважды

  free.addEventListener('input', () => {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(runParse, PARSE_DEBOUNCE_MS);
  });
  free.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      clearTimeout(parseTimer);
      runParse();
    }
  });
  free.addEventListener('blur', () => { clearTimeout(parseTimer); runParse(); });

  root.querySelector('#f-reset').addEventListener('click', () => {
    apply(initial);
    free.value = '';
    lastParsed = '';
    emit();
    toast('Демо-сценарий возвращён', { kind: 'good' });
  });

  paintWeights();

  return { read, apply };

  /**
   * Разбираем текст и заполняем поля тем, что поняли.
   * Не поняли — молчим: форма ниже и так работает.
   */
  async function runParse() {
    const text = free.value.trim();
    if (!text || text === lastParsed) return;
    const seq = ++parseSeq;
    lastParsed = text;

    setBusy(true);
    let patch = null;
    try { patch = await parseRequest(text); } catch { patch = null; }

    if (seq !== parseSeq) return;      // пока ждали, человек дописал — ответ протух
    setBusy(false);

    if (!patch || typeof patch !== 'object') {
      // Ничего не поняли. Молчать нельзя: человек не узнает, сработало ли
      // вообще. Но и ошибкой это не является — форма ниже работает.
      toast('Не разобрали описание', {
        text: 'Заполните поля ниже вручную — или напишите, например: 12 т продуктов из Астаны в Алматы за двое суток',
        kind: 'warn',
      });
      return;
    }

    const touched = [];
    if (patch.from && byId(patch.from))      { fields.from.value = patch.from;      touched.push('from'); }
    if (patch.to && byId(patch.to))          { fields.to.value = patch.to;          touched.push('to'); }
    if (isNum(patch.tons))                   { fields.tons.value = patch.tons;      touched.push('tons'); }
    if (isNum(patch.volumeM3))               { fields.volumeM3.value = patch.volumeM3; touched.push('volumeM3'); }
    if (isNum(patch.deadlineH))              { fields.deadlineH.value = patch.deadlineH; touched.push('deadlineH'); }
    if (patch.cargoType && CARGO_TYPES[patch.cargoType]) {
      const radio = cargoBox.querySelector(`input[value="${patch.cargoType}"]`);
      if (radio) { radio.checked = true; touched.push('cargoType'); }
    }
    if (patch.weights) {
      for (const k of WEIGHT_KEYS) {
        if (isNum(patch.weights[k])) sliders[k].value = Math.round(patch.weights[k] * 100);
      }
      normaliseWeights();
      paintWeights();
      touched.push('weights');
    }

    if (!touched.length) {
      toast('В описании нет новых данных', { text: 'Поля уже стоят так, как вы написали', kind: 'warn' });
      return;
    }
    highlight(touched);
    toast('Заявка обновлена', { text: describe(touched), kind: 'good' });
    emit();
  }

  /** Что именно поняли — человеку, а не в консоль. */
  function describe(keys) {
    const names = {
      from: 'откуда', to: 'куда', tons: 'вес', volumeM3: 'объём',
      deadlineH: 'срок', cargoType: 'тип груза', weights: 'приоритеты',
    };
    const list = keys.map(k => names[k] || k);
    return 'Распознано: ' + list.join(', ');
  }

  function setBusy(on) {
    free.setAttribute('aria-busy', String(on));
    const box = root.querySelector('.field--free');
    let spin = box.querySelector('.field__busy');
    if (on && !spin) {
      spin = document.createElement('span');
      spin.className = 'field__busy';
      box.appendChild(spin);
    }
    if (!on && spin) spin.remove();
  }

  /** Подсветка гаснет сама: это сообщение «вот что я понял», а не состояние. */
  function highlight(keys) {
    for (const key of keys) {
      const node = key === 'cargoType' ? root.querySelector('.field--cargo')
                 : key === 'weights'   ? root.querySelector('.weights')
                 : fields[key]?.closest('.field');
      if (!node) continue;
      node.classList.remove('is-parsed');
      void node.offsetWidth;           // перезапуск анимации
      node.classList.add('is-parsed');
      setTimeout(() => node.classList.remove('is-parsed'), HIGHLIGHT_MS);
    }
  }

  /** После разбора веса могут не дать 100 % — приводим к сумме. */
  function normaliseWeights() {
    const vals = WEIGHT_KEYS.map(k => Math.max(0, Number(sliders[k].value) || 0));
    const s = vals.reduce((a, b) => a + b, 0);
    if (!s) { WEIGHT_KEYS.forEach((k, i) => sliders[k].value = i === 0 ? 34 : 33); return; }
    const scaled = vals.map(v => Math.round(v * 100 / s));
    scaled[0] += 100 - scaled.reduce((a, b) => a + b, 0);
    WEIGHT_KEYS.forEach((k, i) => sliders[k].value = scaled[i]);
  }

  // ------------------------------------------------------------------

  function read() {
    const tons     = clamp(numberOf(fields.tons, 8), 0.5, 68);
    const volumeM3 = clamp(numberOf(fields.volumeM3, 52), 1, 138);
    const deadlineH = clamp(numberOf(fields.deadlineH, 48), 6, 240);
    const checked = cargoBox.querySelector('input:checked');
    return {
      from: fields.from.value,
      to:   fields.to.value,
      tons, volumeM3, deadlineH,
      cargoType: checked ? checked.value : 'food',
      weights: Object.fromEntries(
        WEIGHT_KEYS.map(k => [k, Number(sliders[k].value) / 100])),
    };
  }

  function apply(req) {
    fields.from.value      = req.from;
    fields.to.value        = req.to;
    fields.tons.value      = req.tons;
    fields.volumeM3.value  = req.volumeM3;
    fields.deadlineH.value = req.deadlineH;
    const radio = cargoBox.querySelector(`input[value="${req.cargoType}"]`);
    if (radio) radio.checked = true;
    for (const k of WEIGHT_KEYS) sliders[k].value = Math.round((req.weights?.[k] ?? 0) * 100);
    paintWeights();
  }

  /** Тронули один ползунок — остальные два расходятся пропорционально. */
  function balance(movedKey, movedValue) {
    const rest = WEIGHT_KEYS.filter(k => k !== movedKey);
    const left = 100 - movedValue;
    const cur  = rest.map(k => Number(sliders[k].value));
    const sum  = cur[0] + cur[1];

    let a, b;
    if (sum === 0) {
      a = Math.round(left / 2);
      b = left - a;
    } else {
      a = Math.round(left * cur[0] / sum);
      b = left - a;
    }
    sliders[rest[0]].value = a;
    sliders[rest[1]].value = b;
    sliders[movedKey].value = movedValue;
  }

  function paintWeights() {
    for (const k of WEIGHT_KEYS) {
      const v = Number(sliders[k].value);
      outputs[k].innerHTML = `${v}<i>%</i>`;
      // долю заливки дорожки забирает CSS через --fill
      sliders[k].style.setProperty('--fill', v + '%');
    }
  }

  function emit() {
    // откуда и куда не должны совпадать: молча переставляем «куда»
    if (fields.from.value === fields.to.value) {
      const other = NODES.find(n => n.id !== fields.from.value);
      if (other) fields.to.value = other.id;
    }
    onChange(read());
  }
}

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const byId  = id => NODES.some(n => n.id === id);

const numberOf = (node, fallback) => {
  const v = parseFloat(String(node.value).replace(',', '.'));
  return Number.isFinite(v) ? v : fallback;
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));


/** «Генеральный груз» в сегмент шириной 90 px не влезает. */
function shortCargo(name) {
  return name === 'Генеральный груз' ? 'Генеральный' : name;
}
