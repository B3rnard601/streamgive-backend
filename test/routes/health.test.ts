import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { buildServer } from '../../src/server.js';
import * as rpc from '../../src/stellar/rpc.js';

describe('GET /health', () => {
  beforeEach(() => {
    vi.spyOn(prisma, '$queryRaw').mockResolvedValue([{}]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('responds with 200 when both database and RPC are reachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', db: 'ok', rpc: 'ok' });

    await app.close();
  });

<<<<<<< HEAD
  it('responds with a structured 503 error when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('Database connection failed'));
=======
  it('responds with 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValueOnce(new Error('connection refused'));
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockResolvedValueOnce(1);
>>>>>>> 4d64890 (fix: check Soroban RPC connectivity in the health check)

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
<<<<<<< HEAD
    expect(response.json()).toEqual({ status: 'error', database: 'unreachable' });
=======
    expect(response.json()).toMatchObject({ status: 'error', db: 'error', rpc: 'ok' });

    await app.close();
  });

  it('responds with 503 when the RPC endpoint is unreachable', async () => {
    vi.spyOn(rpc, 'getLatestLedgerSequence').mockRejectedValueOnce(new Error('RPC unreachable'));

    const app = buildServer();

    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: 'error', db: 'ok', rpc: 'error' });
>>>>>>> 4d64890 (fix: check Soroban RPC connectivity in the health check)

    await app.close();
  });

  it('does not rate limit repeated health checks', async () => {
    const previousMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    const app = buildServer();

    const responses = await Promise.all(
      Array.from({ length: 3 }, () => app.inject({ method: 'GET', url: '/health' })),
    );

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);

    await app.close();
    if (previousMax === undefined) delete process.env.RATE_LIMIT_MAX;
    else process.env.RATE_LIMIT_MAX = previousMax;
  });
});
