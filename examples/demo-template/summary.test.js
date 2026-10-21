import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from './summary.js';
test('summarizes positive values',()=>assert.deepEqual(summarize([2,4]),{count:2,total:6,average:3}));
