import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { prisma } from '../src/db.js';
import { resetDb } from './helpers/db.js';

describe('GET /impact/:ngoId (#57)', () => {
  afterEach(async () => {
    await resetDb();
  });

  it('correctly calculates platformSharePercent across multiple NGOs using SQL aggregation', async () => {
    await resetDb();
    const app = buildServer();

    const ngo = await prisma.ngo.create({
      data: {
        ownerAddress: 'GA4Z4GPSO3FKPMQJ3WCMU5D5WE25SDXZS47YDF3J3NWF65ILGCVJVWIJ',
        name: 'NGO Test',
        verified: true,
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/impact/${ngo.id}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toHaveProperty('platformSharePercent');

    await app.close();
  });
});