import { afterEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';

describe('GET /health', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when database is reachable', async () => {
    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });

    await app.close();
  });

  it('responds with a non-200 status when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).not.toBe(200);

    await app.close();
  });
});

describe('GET /health/ready', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 and status ok when DB and RPC are reachable and lag is within threshold', async () => {
    const rpcSpy = vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    const checkpointSpy = vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ok',
      lag: 50,
      latestLedger: 10050,
      checkpointLedger: 10000,
    });

    await app.close();
  });

  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when RPC is unreachable', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockRejectedValue(new Error('RPC connection failed'));
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'service_unavailable' });

    await app.close();
  });

  it('responds with 503 when indexer has no checkpoint', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10050);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(undefined);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_not_started' });

    await app.close();
  });

  it('responds with 503 when indexer lag is above threshold', async () => {
    vi.spyOn(await import('../../src/stellar/rpc.js'), 'getLatestLedgerSequence').mockResolvedValue(10150);
    vi.spyOn(await import('../../src/indexer/checkpoint.js'), 'getCheckpoint').mockResolvedValue(10000);

    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: 'error', reason: 'indexer_lagging', lag: 150, threshold: 100 });

    await app.close();
  });
});
