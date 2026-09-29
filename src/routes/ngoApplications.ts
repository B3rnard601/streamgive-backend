import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { prisma } from '../db.js';
import { requireAdminSignature } from '../middleware/adminAuth.js';

const applicationSchema = z.object({
  ownerAddress: z.string().min(1),
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  website: z.string().url().optional(),
  contactEmail: z.string().email(),
  country: z.string().max(100).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const idParamSchema = z.object({ id: z.string().uuid() });

const statusQuerySchema = z.object({
  // Stellar StrKey ed25519 public key: 'G' + 55 base32 (A-Z2-7) chars.
  // Same regex as GET /ngos/lookup.
  ownerAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/),
});

const reviewBodySchema = z.object({
  reviewNote: z.string().max(2000).optional(),
});

/**
 * Inserts a PENDING application, or reports the application that already
 * blocks this address.
 *
 * Read-then-write is a race on its own: two POSTs that arrive together both
 * read "nothing blocking", both insert, and one address ends up with two
 * PENDING applications. The obvious remedy — a partial unique index on
 * (owner_address) WHERE status = 'PENDING' — is not available here. This
 * project syncs its schema with `prisma db push` and has no migration files
 * (see DEPLOYMENT.md), so a raw index would never be applied, and Prisma's
 * schema language cannot express a partial index anyway.
 *
 * So the insert is serialised in the database instead: a transaction-scoped
 * advisory lock keyed on the owner address. The second request blocks until
 * the first transaction commits, then re-reads inside its own transaction and
 * sees the row the winner inserted, taking the 409 path. Postgres releases
 * the lock at COMMIT or ROLLBACK, so a crashed request cannot wedge the
 * address, and a `hashtext` collision only serialises two unrelated addresses
 * — it can never let a duplicate through.
 */
async function createApplicationUnlessBlocked(data: z.infer<typeof applicationSchema>) {
  return prisma.$transaction(async (tx) => {
    // `::text` pins the bind parameter's type instead of leaving it to the
    // server to infer.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${data.ownerAddress}::text)::bigint)`;

    const existingApp = await tx.ngoApplication.findFirst({
      where: {
        ownerAddress: data.ownerAddress,
        status: { in: ['PENDING', 'APPROVED'] },
      },
    });
    if (existingApp) {
      return { ok: false as const, status: existingApp.status };
    }

    return { ok: true as const, application: await tx.ngoApplication.create({ data }) };
  });
}

export async function ngoApplicationRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/ngo-applications',
    // Public write endpoint — tighter than the global default since it's
    // the most spam-prone route in the API.
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = applicationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const result = await createApplicationUnlessBlocked(parsed.data);
      if (!result.ok) {
        if (result.status === 'APPROVED') {
          return reply.code(409).send({ error: 'already_approved' });
        }
        return reply.code(409).send({ error: 'application_already_pending' });
      }

      return reply.code(201).send(result.application);
    },
  );

  // Public read endpoint: an applicant can check their own review status
  // without an admin signature. Deliberately returns only the review
  // outcome and timestamps — never the contact details or description
  // submitted with the application, since anyone who knows (or guesses) an
  // address could otherwise read them.
  app.get('/ngo-applications/status', async (request, reply) => {
    const parsed = statusQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const application = await prisma.ngoApplication.findFirst({
      where: { ownerAddress: parsed.data.ownerAddress },
      orderBy: { createdAt: 'desc' },
      select: { status: true, createdAt: true, updatedAt: true },
    });
    if (!application) {
      return reply.code(404).send({ error: 'not_found' });
    }

    return application;
  });

  app.get('/ngo-applications', { preHandler: requireAdminSignature }, async (request, reply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
    }

    const where = parsed.data.status ? { status: parsed.data.status } : {};

    const [applications, total] = await Promise.all([
      prisma.ngoApplication.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: parsed.data.limit,
        skip: parsed.data.offset,
      }),
      prisma.ngoApplication.count({ where }),
    ]);

    return { applications, total, limit: parsed.data.limit, offset: parsed.data.offset };
  });

  app.get(
    '/ngo-applications/:id',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }

      const application = await prisma.ngoApplication.findUnique({
        where: { id: parsedParams.data.id },
      });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }

      return application;
    },
  );

  app.post(
    '/ngo-applications/:id/approve',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      return await prisma.ngoApplication.update({
        where: { id },
        data: { status: 'APPROVED', reviewNote: parsed.data.reviewNote },
      });
    },
  );

  app.post(
    '/ngo-applications/:id/reject',
    { preHandler: requireAdminSignature },
    async (request, reply) => {
      const parsedParams = idParamSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: 'invalid_request' });
      }
      const { id } = parsedParams.data;

      const parsed = reviewBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request', details: parsed.error.flatten() });
      }

      const application = await prisma.ngoApplication.findUnique({ where: { id } });
      if (!application) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (application.status !== 'PENDING') {
        return reply.code(409).send({ error: 'already_reviewed' });
      }

      return await prisma.ngoApplication.update({
        where: { id },
        data: { status: 'REJECTED', reviewNote: parsed.data.reviewNote },
      });
    },
  );
}
