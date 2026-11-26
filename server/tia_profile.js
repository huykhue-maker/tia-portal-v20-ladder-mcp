'use strict';

function portalVersion(value = '20') {
  if (value !== '16' && value !== '20') throw new Error('Expected TIA Portal version 16 or 20, got ' + JSON.stringify(value));
  return value;
}

const V16_UNAVAILABLE_TOOLS = new Set([
  'tia_cross_reference', 'tia_plcsim_runtime',
]);

module.exports = { portalVersion, V16_UNAVAILABLE_TOOLS };
