import express from 'express';
import { requireAdmin } from '../middleware/auth.js';
import { getHlsSettings, setHlsSettings, HLS_LIMITS } from '../lib/settings.js';
import { restartLiveTranscoders } from '../lib/transcode.js';

const router = express.Router();
router.use(requireAdmin);

// GET /api/settings — current HLS transcode settings plus the accepted ranges.
router.get('/', async (_req, res) => {
  try {
    const hls = await getHlsSettings();
    res.json({ hls, limits: HLS_LIMITS });
  } catch (err) {
    console.error('[settings] read failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

// PUT /api/settings  { hlsTime?, hlsListSize?, apply? }
// `apply` restarts the transcoder of every currently-live stream so the new
// values take effect immediately; without it they apply from the next start.
router.put('/', async (req, res) => {
  const body = req.body || {};
  if (body.hlsTime === undefined && body.hlsListSize === undefined) {
    return res.status(400).json({ error: 'nothing_to_update' });
  }
  try {
    const current = await getHlsSettings();
    const hls = await setHlsSettings({
      hlsTime: body.hlsTime === undefined ? current.hlsTime : body.hlsTime,
      hlsListSize: body.hlsListSize === undefined ? current.hlsListSize : body.hlsListSize,
    });
    const restarted = body.apply ? await restartLiveTranscoders() : [];
    res.json({ hls, restarted });
  } catch (err) {
    console.error('[settings] write failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

export default router;
