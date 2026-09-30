import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/indexer/checkpoint.js', () => ({
  getCheckpoint: vi.fn(),
  saveCheckpoint: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../src/stellar/rpc.js', () => ({
  getLatestLedgerSequence: vi.fn(),
  rpcServer: { getEvents: vi.fn() },
}));
vi.mock('../src/indexer/contracts.js', () => ({ WATCHED_CONTRACT_IDS: ['CONTRACT_A'] }));

const checkpoint = await import('../src/indexer/checkpoint.js');
const rpc = await import('../src/stellar/rpc.js');

afterEach(() => {
  delete process.env.INDEXER_POLL_INTERVAL_MS;
});

describe('indexer polling', () => {
  it('does not overlap polls when an RPC request takes longer than the interval', async () => {
    process.env.INDEXER_POLL_INTERVAL_MS = '10';
    vi.resetModules();
    vi.doMock('../src/indexer/checkpoint.js', () => ({
      getCheckpoint: checkpoint.getCheckpoint,
      saveCheckpoint: checkpoint.saveCheckpoint,
    }));
    vi.doMock('../src/stellar/rpc.js', () => ({
      getLatestLedgerSequence: rpc.getLatestLedgerSequence,
      rpcServer: rpc.rpcServer,
    }));
    vi.doMock('../src/indexer/contracts.js', () => ({ WATCHED_CONTRACT_IDS: ['CONTRACT_A'] }));

    vi.mocked(checkpoint.getCheckpoint).mockResolvedValue(100);
    let latestLedger = 100;
    vi.mocked(rpc.getLatestLedgerSequence).mockImplementation(async () => ++latestLedger);

    let activePolls = 0;
    let maxConcurrentPolls = 0;
    let pollCount = 0;
    vi.mocked(rpc.rpcServer.getEvents).mockImplementation(async () => {
      activePolls++;
      maxConcurrentPolls = Math.max(maxConcurrentPolls, activePolls);
      pollCount++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      activePolls--;
      return { events: [] } as never;
    });

    const { startIndexer } = await import('../src/indexer/worker.js');
    const stop = startIndexer(async () => {});
    await new Promise((resolve) => setTimeout(resolve, 140));
    await stop();

    expect(maxConcurrentPolls).toBe(1);
    expect(pollCount).toBeGreaterThan(1);
  });
});