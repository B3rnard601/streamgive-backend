import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn(),
  getLatestLedgerSequence: vi.fn(),
  getEvents: vi.fn(),
}));

vi.mock('../../src/indexer/contracts.js', () => ({
  WATCHED_CONTRACT_IDS: ['test-contract'],
}));

vi.mock('../../src/indexer/checkpoint.js', () => ({
  getCheckpoint: mocks.getCheckpoint,
  saveCheckpoint: mocks.saveCheckpoint,
}));

vi.mock('../../src/stellar/rpc.js', () => ({
  getLatestLedgerSequence: mocks.getLatestLedgerSequence,
  rpcServer: {
    getEvents: mocks.getEvents,
  },
}));

describe('indexer checkpoint recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();

    mocks.getCheckpoint.mockReset();
    mocks.saveCheckpoint.mockReset();
    mocks.getLatestLedgerSequence.mockReset();
    mocks.getEvents.mockReset();

    mocks.getCheckpoint.mockResolvedValue(100);
    mocks.getLatestLedgerSequence.mockResolvedValue(500);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('recovers from an out-of-range checkpoint', async () => {
    const { startIndexer } = await import(
      '../../src/indexer/worker.js'
    );

    mocks.getEvents.mockRejectedValue(
      new Error(
        'startLedger must be within the ledger range of the RPC server',
      ),
    );

    const stopIndexer = startIndexer(vi.fn());

    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.saveCheckpoint).toHaveBeenCalledWith(500);

    stopIndexer();
  });

  it('rethrows an unrelated error without advancing the checkpoint', async () => {
    const { startIndexer } = await import(
      '../../src/indexer/worker.js'
    );

    const error = new Error('RPC connection failed');

    mocks.getEvents.mockRejectedValue(error);

    const stopIndexer = startIndexer(vi.fn());

    await vi.advanceTimersByTimeAsync(5000);

    expect(mocks.saveCheckpoint).not.toHaveBeenCalled();

    stopIndexer();
  });
});