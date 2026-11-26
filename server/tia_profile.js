'use strict';

function portalVersion(value = '20') {
  if (value !== '16' && value !== '20') throw new Error('Expected TIA Portal version 16 or 20, got ' + JSON.stringify(value));
  return value;
}

const V16_UNAVAILABLE_TOOLS = new Set([
  'tia_download_and_online', 'tia_watch_table', 'tia_show_in_editor', 'tia_scl_source',
  'tia_cross_reference', 'tia_hardware_config', 'tia_network_config', 'tia_plcsim_runtime', 'tia_escape_hatch',
]);

module.exports = { portalVersion, V16_UNAVAILABLE_TOOLS };
