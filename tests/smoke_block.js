'use strict';
const B = require('../server/ladder/block');
const spec = {
  type: 'FB', name: 'FB_Spindle', number: 10,
  interface: {
    Input: [{ name: 'Start', type: 'Bool', comment: 'Nut start' }, { name: 'Stop', type: 'Bool' }, { name: 'EStop', type: 'Bool' }],
    Output: [{ name: 'Run', type: 'Bool' }, { name: 'Ready', type: 'Bool' }],
    Temp: [{ name: 'tmp', type: 'Int' }],
  },
  networks: [
    { title: 'Start/stop latch', dsl: '(#Start | #Run) & !#Stop & !#EStop => COIL(#Run)' },
    { title: 'Ready after 3s', dsl: 'NO(#Run) => TON(#T1, PT=T#3s) => COIL(#Ready)\nRTRIG(#m1) & GE(#tmp, 5) => ADD(#tmp, 1, #tmp)' },
  ],
};
const created = B.createBlockXml(spec, {});
console.log(created.xml.split('\n').length + ' lines, declared:', JSON.stringify(created.declared));
const r = B.readBlock(created.xml, { format: 'both', ctx: {} });
console.log(B.formatBlock(r));
console.log('--- patch');
const p = B.patchNetworks(created.xml, [
  { op: 'replace', nw: 1, dsl: '(#Start | #Run) & NC(#Stop) & NC(#EStop) & NC(#Ready) => COIL(#Run)', title: 'Latch v2' },
  { op: 'append', dsl: 'NO(#Run) => MOVE(5, #tmp)', title: 'Move' },
  { op: 'delete', nw: 2 },
], {});
console.log(p.changes);
const r2 = B.readBlock(p.xml, { format: 'dsl' });
console.log(B.formatBlock(r2));
