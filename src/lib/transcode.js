import { spawn, execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import prisma from './prisma.js';
import { isLive } from './redis.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', '..', 'bin', 'hls-transcode.sh');

// Kill the transcoder for one stream key. The running ffmpeg carries the RTMP
// ingest URL (…/live/<key>) on its command line, which is what we match on.
function killTranscoder(streamKey) {
  try {
    execFile('pkill', ['-f', `live/${streamKey}`], () => {});
  } catch { /* ignore */ }
}

function spawnTranscoder(streamKey) {
  try {
    const child = spawn(SCRIPT, [streamKey], { detached: true, stdio: 'ignore' });
    child.unref();
  } catch { /* ignore */ }
}

// Restart the transcoder for every stream that is currently publishing, so a
// changed segment duration or playlist window takes effect immediately instead
// of waiting for the next publish. The script kills any stale transcoder for
// the same key before it starts, so this is safe to call repeatedly.
export async function restartLiveTranscoders() {
  let streams = [];
  try {
    streams = await prisma.stream.findMany({
      where: { isActive: true },
      select: { streamKey: true },
    });
  } catch {
    return [];
  }

  const restarted = [];
  for (const { streamKey } of streams) {
    let live = false;
    try { live = await isLive(streamKey); } catch { live = false; }
    if (!live) continue;
    killTranscoder(streamKey);
    spawnTranscoder(streamKey);
    restarted.push(streamKey);
  }
  return restarted;
}
