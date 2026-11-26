'use strict';

const { setTimeout } = require('node:timers/promises');
const { BridgeClient } = require('../../server/bridge_client');

// This preload is used only by the FIFO test child process.
BridgeClient.prototype.call = async function (command) {
  if (command !== 'status') throw new Error('Unexpected bridge command: ' + command);
  await setTimeout(75);
  throw new Error('fixture status rejected');
};
