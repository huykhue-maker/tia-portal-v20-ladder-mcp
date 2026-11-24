'use strict';
const d = require('../server/ladder/dsl');
const src = [
  '(#Start | #Latch) & !#Stop & NC("E_Stop") => COIL(#Latch)',
  'NO(#Latch) => TON(#T1, PT=T#3s) => COIL(#Ready), SET(%Q0.1)',
  'GE(#cnt, 5, Int) & RTRIG(#m1) => ADD(#cnt, 1, #cnt, Int), MOVE(5, #x)',
  'NO(#sensor) => CTU(#C1, PV=10, R=NO(#rst)) => { COIL(#full); NO(#a) => RESET(#b) }',
  'TRUE => CALL("FB_Axis", inst="DB_Axis", Enable=#en, Go=NO(#go) & NO(#ok))',
].join('\n');
const r = d.parseNetwork(src);
console.log(d.printNetwork(r.flows));
for (const bad of ['NO(#a) COIL(#b)', 'NO(#a) => FOO(#b)', 'COIL(#a) => COIL(#b)', 'NO(#a) => COIL(#b', '%Q => COIL(#a)']) {
  try { d.parseNetwork(bad); console.log('NO ERROR for', bad); } catch (e) { console.log('ERR:', e.message); }
}
