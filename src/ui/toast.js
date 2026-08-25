// =====================================================================
//  TOLYQ / UI — УВЕДОМЛЕНИЯ
// ---------------------------------------------------------------------
//  Короткие сообщения о том, что произошло по действию человека. Нужны
//  ровно там, где результат иначе не виден: разбор свободного текста
//  может ничего не понять, и без реплики непонятно, сработало ли вообще.
//
//  Правила: не больше трёх на экране, сами гаснут, кликов не требуют,
//  ошибку не глушим — она висит дольше.
// =====================================================================

const MAX = 3;
const LIFE = { info: 3200, good: 3200, warn: 4200, bad: 5200 };

let host = null;

function mount() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'toasts';
  host.setAttribute('role', 'status');
  host.setAttribute('aria-live', 'polite');
  document.body.appendChild(host);
  return host;
}

/**
 * @param {string} title  что произошло, одной строкой
 * @param {object} [opts]
 * @param {string} [opts.text] подробность помельче
 * @param {'info'|'good'|'warn'|'bad'} [opts.kind]
 */
export function toast(title, { text = '', kind = 'info' } = {}) {
  const box = mount();

  while (box.childElementCount >= MAX) box.firstElementChild.remove();

  const node = document.createElement('div');
  node.className = 'toast' + (kind === 'info' ? '' : ` toast--${kind}`);
  node.innerHTML =
    `<div class="toast__body">
       <div class="toast__title">${esc(title)}</div>
       ${text ? `<div class="toast__text">${esc(text)}</div>` : ''}
     </div>`;
  box.appendChild(node);

  const life = LIFE[kind] ?? LIFE.info;
  setTimeout(() => {
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }, life);

  return node;
}

const esc = s => String(s).replace(/[&<>"]/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
