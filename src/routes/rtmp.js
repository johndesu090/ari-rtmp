import express from 'express';
import prisma from '../lib/prisma.js';
import { markLive, markOffline } from '../lib/redis.js';

const router = express.Router();

// nginx-rtmp sends application/x-www-form-urlencoded with fields like:
//   call=publish, addr, app, name (the stream key), flashver, tcurl, pageurl
// A 2xx response allows the ingest; anything else rejects it immediately.
//
// These endpoints are reachable only on 127.0.0.1 (the API binds to loopback
// and is fronted by nginx), so network isolation is the access control here.

function formBody(req) {
  // express.urlencoded is mounted globally in server.js
  return req.body || {};
}

// POST /api/rtmp/on_publish
router.post('/on_publish', async (req, res) => {
  const { name, addr, app } = formBody(req);
  const streamKey = String(name || '').trim();

  if (!streamKey) {
    console.warn('[rtmp] on_publish rejected: missing stream key');
    return res.status(403).send('missing stream key');
  }

  try {
    const stream = await prisma.stream.findUnique({ where: { streamKey } });

    if (!stream || !stream.isActive) {
      console.warn(
        `[rtmp] on_publish rejected key=${streamKey} app=${app} addr=${addr} ` +
          `(reason=${!stream ? 'unknown_key' : 'inactive'})`,
      );
      return res.status(403).send('invalid or inactive stream key');
    }

    await markLive(streamKey, addr);
    console.log(`[rtmp] on_publish accepted key=${streamKey} addr=${addr}`);
    return res.status(200).send('ok');
  } catch (err) {
    console.error('[rtmp] on_publish error:', err);
    // Fail closed: deny the ingest if we cannot verify the key.
    return res.status(500).send('internal error');
  }
});

// POST /api/rtmp/on_publish_done
router.post('/on_publish_done', async (req, res) => {
  const { name, addr } = formBody(req);
  const streamKey = String(name || '').trim();
  if (streamKey) {
    await markOffline(streamKey);
    console.log(`[rtmp] on_publish_done key=${streamKey} addr=${addr}`);
  }
  return res.status(200).send('ok');
});

export default router;
