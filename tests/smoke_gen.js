'use strict';
const d = require('../server/ladder/dsl');
const g = require('../server/ladder/gen');
const src = process.argv[2] || '(#Start | #Latch) & NC(#Stop) => COIL(#Latch)\nNO(#Latch) => TON(#T1, PT=T#3s) => COIL(#Ready), SET(%Q0.1)';
const flows = d.parseNetwork(src).flows;
const out = g.generateFlgNet(flows, { callCatalog: {} });
console.log(out.xml);
console.log(JSON.stringify(out.decls));
