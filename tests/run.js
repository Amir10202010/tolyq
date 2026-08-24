// Раннер для node: node tests/run.js
// Код возврата 1 при падениях — годится для CI, если он появится.
import { run } from './all.js';

const res = run((line) => console.log(line));

if (typeof process !== 'undefined' && res.failed > 0) process.exit(1);
