import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { normalizeRecommendations } from '../../src/server/qloo/normalize';
import { ATHENS_ORIGIN } from '../../src/server/practical/origin';

const captureDir = process.env.REPORTED_FACTS_CAPTURE_DIR;
test.skipIf(!captureDir)('RF01: read-only retained pilot replay preserves 30 dining/12 museum fields, ordinals and evidence; zero calls', async () => {
  const transport = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Replay must not make requests'));
  try {
    const counts: number[] = []; const rawBytes: number[] = [];
    for (const name of await readdir(captureDir!)) {
      const capture = JSON.parse(await readFile(join(captureDir!, name), 'utf8'));
      if (capture.request.route !== '/v2/insights') continue;
      expect(capture.status).toBe(200);
      const raw = Buffer.from(capture.rawBody, 'base64');
      expect(createHash('sha256').update(raw).digest('hex')).toBe(capture.digest);
      const body = JSON.parse(raw.toString('utf8'));
      const category = body.results.entities.length === 30 ? 'dining' : 'attractions';
      const tag = capture.request.parameters['filter.tags'];
      const evidence = { privateRef: name, digest: capture.digest, retrievedAt: capture.retrievedAt };
      const normalized = normalizeRecommendations(body, category, Number(capture.request.parameters['filter.location.radius']), {
        origin: ATHENS_ORIGIN!, athensCityNames: ['Athens', 'Municipality of Athens', 'Αθήνα', 'Athina'], categoryTagIds: { dining: tag, attractions: tag },
      }, evidence, []);
      expect(normalized).toHaveLength(category === 'dining' ? 30 : 12);
      normalized.forEach((candidate, index) => {
        expect(candidate.qlooRank).toBe(index + 1); expect(candidate.evidence).toEqual(evidence);
        expect(candidate.qlooEntityId).toBe(body.results.entities[index].entity_id);
        expect(candidate.qlooReported).toEqual({ cityId: 'athens', category, coordinates: { latitude: body.results.entities[index].location.lat, longitude: body.results.entities[index].location.lon } });
      });
      counts.push(normalized.length); rawBytes.push(raw.byteLength);
    }
    expect(counts.sort((a, b) => b - a)).toEqual([30, 12]);
    expect(rawBytes.every(size => size > 0 && size <= 2_097_152)).toBe(true);
    expect(transport).toHaveBeenCalledTimes(0);
  } finally { transport.mockRestore(); }
});
