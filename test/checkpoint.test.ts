import { afterEach, describe, expect, it } from 'vitest';

import { getCheckpoint, saveCheckpoint } from '../src/indexer/checkpoint.js';
import { resetDb } from './helpers/db.js';

describe('indexer checkpoint persistence', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('returns undefined when no checkpoint has been saved', async () => {
    await expect(getCheckpoint()).resolves.toBeUndefined();
  });

  it('saves and reads the latest processed ledger', async () => {
    await saveCheckpoint(100);
    await saveCheckpoint(125);

    await expect(getCheckpoint()).resolves.toBe(125);
  });
});