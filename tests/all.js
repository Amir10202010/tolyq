// Единый список тест-модулей. Импорт регистрирует suite/test в харнессе.
// Добавляя новый тест-файл — допиши его сюда, оба раннера подхватят.
import './random.test.js';
import './network.test.js';
import './co2.test.js';
import './pareto.test.js';
import './solve.test.js';

export { run } from './harness.js';
