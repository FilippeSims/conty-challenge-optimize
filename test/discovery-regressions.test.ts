import type { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { deliveriesSince } from "../src/clock.ts";
import { getQueryCount, openDatabase, resetQueryCount } from "../src/db.ts";
import type { CreatorMatch, CreatorPage } from "../src/list-creators.ts";
import { CAMPAIGN_ID, FIXTURE_SEED, seed } from "../src/seed.ts";

// Oráculo com as consultas e regras da listagem original, independente do lote otimizado.
function originalMatches(db: DatabaseSync): CreatorMatch[] {
  const campaign = db.prepare("SELECT niches_json FROM campaigns WHERE id = ?").get(CAMPAIGN_ID) as {
    niches_json: string;
  };
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const creators = db.prepare("SELECT id, name, niches_json FROM creators").all() as Array<{
    id: string;
    name: string;
    niches_json: string;
  }>;
  const matches: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    const accounts = db.prepare("SELECT id FROM social_accounts WHERE creator_id = ?").all(creator.id) as
      Array<{ id: string }>;
    let latestReach = 0;
    for (const account of accounts) {
      const metric = db.prepare(
        "SELECT views FROM metrics WHERE account_id = ? ORDER BY captured_at DESC, id DESC LIMIT 1",
      ).get(account.id) as { views: number } | undefined;
      if (metric) latestReach += metric.views;
    }
    const deliveries = db.prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE creator_id = ? AND delivered_at >= ?",
    ).get(creator.id, deliveriesSince()) as { n: number };

    matches.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: latestReach,
      deliveries_90d: Number(deliveries.n),
    });
  }

  return matches.sort((left, right) =>
    right.niche_score - left.niche_score || right.latest_reach - left.latest_reach ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
  );
}

describe("equivalência da descoberta em volume maior", () => {
  let db: DatabaseSync;
  let app: ReturnType<typeof createApp>;
  let expected: CreatorMatch[];

  beforeAll(() => {
    db = openDatabase();
    seed(db, { creators: 2500, seed: 7 });
    db.exec(`
      UPDATE creators SET niches_json = '["beleza","beleza","moda"]' WHERE id = 'crt_0001';
      INSERT INTO metrics VALUES
        ('met_tie_a', 'acc_crt_0001_0', 555, '2026-06-01T12:00:00.000Z', ''),
        ('met_tie_z', 'acc_crt_0001_0', 999, '2026-06-01T12:00:00.000Z', '');
      INSERT INTO social_accounts VALUES ('acc_extra', 'crt_0001', 'tiktok');
      INSERT INTO metrics VALUES ('met_extra', 'acc_extra', 17, '2026-06-01T12:00:00.000Z', '');
    `);
    expected = originalMatches(db);
    app = createApp(db);
  });

  beforeEach(() => resetQueryCount());
  afterAll(() => db.close());

  it.each([[20, 0], [20, 20], [50, 10], [20, 2500]])(
    "preserva a listagem original com limit=%i e offset=%i dentro do orçamento",
    async (limit, offset) => {
      const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=${limit}&offset=${offset}`);
      expect(response.status).toBe(200);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      expect(await response.json()).toEqual({
        campaign_id: CAMPAIGN_ID,
        total: expected.length,
        creators: expected.slice(offset, offset + limit),
      });
    },
  );

  it("preserva a última página incompleta e o total", async () => {
    const offset = expected.length - 5;
    const response = await app.request(`/campaigns/${CAMPAIGN_ID}/creators?limit=20&offset=${offset}`);
    expect(getQueryCount()).toBeLessThanOrEqual(8);
    expect(await response.json()).toEqual({
      campaign_id: CAMPAIGN_ID,
      total: expected.length,
      creators: expected.slice(offset),
    });
  });

  it("não reutiliza resultados de outro banco com o mesmo id de campanha", async () => {
    const other = openDatabase();
    try {
      seed(other, FIXTURE_SEED);
      const response = await createApp(other).request(`/campaigns/${CAMPAIGN_ID}/creators`);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      const matches = originalMatches(other);
      expect(await response.json()).toEqual({
        campaign_id: CAMPAIGN_ID,
        total: matches.length,
        creators: matches.slice(0, 20),
      });
    } finally {
      other.close();
    }
  });

  it("reflete uma nova métrica sem devolver uma resposta em cache", async () => {
    const path = `/campaigns/${CAMPAIGN_ID}/creators`;
    const before = await app.request(path);
    const previous = (await before.json()) as CreatorPage;
    db.prepare("INSERT INTO metrics VALUES (?, ?, ?, ?, ?)").run(
      "met_updated", "acc_crt_0001_0", 999999, "2026-06-02T12:00:00.000Z", "",
    );
    try {
      resetQueryCount();
      const response = await app.request(path);
      expect(getQueryCount()).toBeLessThanOrEqual(8);
      const matches = originalMatches(db);
      const current = (await response.json()) as CreatorPage;
      expect(current).toEqual({
        campaign_id: CAMPAIGN_ID,
        total: matches.length,
        creators: matches.slice(0, 20),
      });
      expect(current.creators[0]?.latest_reach).not.toBe(previous.creators[0]?.latest_reach);
    } finally {
      db.prepare("DELETE FROM metrics WHERE id = ?").run("met_updated");
    }
  });
});
