import { xdr } from '@stellar/stellar-sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prisma } from '../../src/db.js';
import { getCheckpoint, saveCheckpoint } from '../../src/indexer/checkpoint.js';
import { fakeAddress, resetDb } from '../helpers/db.js';
import { addressScVal, i128ScVal, makeEvent, symbolScVal, u64ScVal } from '../helpers/events.js';

const mocks = vi.hoisted(() => {
  const contractId = 'CTESTCONTRACTID';

  // contracts.ts reads this at module load, and `pollOnce` no-ops when no
  // contract id is configured — vi.hoisted() runs before this file's imports,
  // which is the only point early enough to set it. The value matches the
  // contract id makeEvent() stamps on its fixtures, so dispatchEvent routes
  // them to the donation-vault handler.
  process.env.DONATION_VAULT_CONTRACT_ID = contractId;

  return {
    contractId,
    getEvents: vi.fn(),
    getLatestLedgerSequence: vi.fn(),
    // Memoised here, in a closure the module registry reset below does not
    // touch, so every re-import shares one PrismaClient (and one connection
    // pool) instead of opening a fresh one per case.
    db: undefined as { prisma: typeof prisma } | undefined,
  };
});

vi.mock('../../src/db.js', async () => {
  mocks.db ??= { ...(await vi.importActual<{ prisma: typeof prisma }>('../../src/db.js')) };
  return mocks.db;
});

vi.mock('../../src/stellar/rpc.js', () => ({
  rpcServer: { getEvents: mocks.getEvents },
  getLatestLedgerSequence: mocks.getLatestLedgerSequence,
}));

/**
 * `pollOnce` caches its checkpoint in a module-level variable for the life of
 * the process. Re-importing the worker gives each case an indexer that reads
 * the checkpoint back from the database, so the cases stay independent of
 * each other and of the order they run in.
 */
async function freshIndexer() {
  vi.resetModules();
  const [{ pollOnce }, { dispatchEvent }] = await Promise.all([
    import('../../src/indexer/worker.js'),
    import('../../src/indexer/dispatch.js'),
  ]);
  return { pollOnce, dispatchEvent };
}

/**
 * A `created` event whose payload is a bare i128 instead of the
 * `[donor, ngo, token, deposit, rate]` vector the handler destructures. This
 * is exactly the shape mismatch the handler's unchecked `as [...]` cast
 * cannot survive: destructuring a bigint throws, and without per-event
 * isolation that throw escapes `pollOnce` before it can save a checkpoint.
 */
function malformedCreatedEvent(ledger: number) {
  return makeEvent([symbolScVal('created'), u64ScVal(99n)], i128ScVal(1000n), {
    id: `poison-${ledger}`,
    ledger,
  });
}

function wellFormedCreatedEvent(ledger: number, onChainId: bigint) {
  return makeEvent(
    [symbolScVal('created'), u64ScVal(onChainId)],
    xdr.ScVal.scvVec([
      addressScVal(fakeAddress('A')),
      addressScVal(fakeAddress('B')),
      addressScVal(fakeAddress('C')),
      i128ScVal(1000n),
      i128ScVal(10n),
    ]),
    { id: `good-${ledger}`, ledger },
  );
}

describe('pollOnce', () => {
  beforeEach(() => {
    mocks.getEvents.mockReset();
    mocks.getLatestLedgerSequence.mockReset();
    // The dead-letter path logs through console.error and the email
    // notification stub through console.log; neither is under test here.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDb();
  });

  afterAll(() => {
    delete process.env.DONATION_VAULT_CONTRACT_ID;
  });

  it('advances past a malformed event instead of retrying it forever', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(100);
    mocks.getLatestLedgerSequence.mockResolvedValue(110);

    // Both events arrive in one batch with the undecodable one first, so a
    // handler failure that propagated would take the good event down with it.
    mocks.getEvents.mockResolvedValueOnce({
      events: [malformedCreatedEvent(101), wellFormedCreatedEvent(102, 7n)],
      latestLedger: 110,
    });

    await pollOnce(dispatchEvent);

    // The checkpoint moved past the poison event and on through the good one.
    expect(await getCheckpoint()).toBe(102);

    // The event behind it was indexed rather than blocked.
    const stream = await prisma.stream.findUnique({ where: { onChainId: 7n } });
    expect(stream?.balance).toBe('1000');

    // The failure is recorded rather than silently dropped.
    const deadLetter = await prisma.indexerDeadLetter.findUnique({
      where: { eventId: 'poison-101' },
    });
    expect(deadLetter?.ledger).toBe(101);
    expect(deadLetter?.contractId).toBe(mocks.contractId);
    expect(deadLetter?.error).not.toBe('');

    // And the next poll starts after it, so it is never seen again — the
    // wedge this whole change exists to prevent.
    mocks.getEvents.mockResolvedValueOnce({ events: [], latestLedger: 110 });
    await pollOnce(dispatchEvent);

    expect(mocks.getEvents).toHaveBeenLastCalledWith(expect.objectContaining({ startLedger: 103 }));
    expect(await getCheckpoint()).toBe(110);
  });

  it('records one dead letter per failing event and keeps going', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(200);
    mocks.getLatestLedgerSequence.mockResolvedValue(220);
    mocks.getEvents.mockResolvedValueOnce({
      events: [
        malformedCreatedEvent(201),
        malformedCreatedEvent(202),
        wellFormedCreatedEvent(203, 8n),
      ],
      latestLedger: 220,
    });

    await pollOnce(dispatchEvent);

    expect(await getCheckpoint()).toBe(203);
    expect(await prisma.indexerDeadLetter.count()).toBe(2);
    expect(await prisma.stream.findUnique({ where: { onChainId: 8n } })).not.toBeNull();
  });

  it('writes no dead letters when every event handles cleanly', async () => {
    const { pollOnce, dispatchEvent } = await freshIndexer();

    await saveCheckpoint(300);
    mocks.getLatestLedgerSequence.mockResolvedValue(320);
    mocks.getEvents.mockResolvedValueOnce({
      events: [wellFormedCreatedEvent(301, 9n)],
      latestLedger: 320,
    });

    await pollOnce(dispatchEvent);

    expect(await getCheckpoint()).toBe(301);
    expect(await prisma.indexerDeadLetter.count()).toBe(0);
    expect(await prisma.stream.findUnique({ where: { onChainId: 9n } })).not.toBeNull();
  });
});
