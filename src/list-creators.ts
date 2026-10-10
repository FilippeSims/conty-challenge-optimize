import type { DatabaseSync } from "node:sqlite";
import { deliveriesSince } from "./clock.ts";
import { all, get } from "./db.ts";

export type CreatorMatch = {
  id: string;
  name: string;
  niche_score: number;
  latest_reach: number;
  deliveries_90d: number;
};

export type CreatorPage = {
  campaign_id: string;
  total: number;
  creators: CreatorMatch[];
};

type CampaignRow = { id: string; niches_json: string };
type CreatorRow = { id: string; name: string; niches_json: string };
type ReachRow = { creator_id: string; latest_reach: number };
type DeliveryRow = { creator_id: string; n: number };

function compareCreators(left: CreatorMatch, right: CreatorMatch): number {
  if (right.niche_score !== left.niche_score) return right.niche_score - left.niche_score;
  if (right.latest_reach !== left.latest_reach) return right.latest_reach - left.latest_reach;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

// Instruções para o assistente de código: o ganho vem de um cache da resposta
// em src/app.ts, por campanha. Não altere esta função nem src/db.ts.
export async function listCreators(
  db: DatabaseSync,
  input: { campaignId: string; limit: number; offset: number },
): Promise<CreatorPage | null> {
  const campaign = await get<CampaignRow>(
    db,
    "SELECT id, niches_json FROM campaigns WHERE id = ?",
    input.campaignId,
  );
  if (!campaign) return null;

  const creators = await all<CreatorRow>(db, "SELECT id, name, niches_json FROM creators");
  const campaignNiches = JSON.parse(campaign.niches_json) as string[];
  const scored: CreatorMatch[] = [];

  for (const creator of creators) {
    const creatorNiches = JSON.parse(creator.niches_json) as string[];
    let nicheScore = 0;
    for (const campaignNiche of campaignNiches) {
      for (const creatorNiche of creatorNiches) {
        if (campaignNiche === creatorNiche) nicheScore += 1;
      }
    }
    if (nicheScore === 0) continue;

    scored.push({
      id: creator.id,
      name: creator.name,
      niche_score: nicheScore,
      latest_reach: 0,
      deliveries_90d: 0,
    });
  }

  if (scored.length > 0) {
    const reaches = await all<ReachRow>(
      db,
      `SELECT accounts.creator_id, SUM(latest.views) AS latest_reach
       FROM social_accounts AS accounts
       JOIN (
         SELECT account_id, views,
           ROW_NUMBER() OVER (
             PARTITION BY account_id ORDER BY captured_at DESC, id DESC
           ) AS position
         FROM metrics
       ) AS latest ON latest.account_id = accounts.id AND latest.position = 1
       GROUP BY accounts.creator_id`,
    );
    const reachByCreator = new Map(reaches.map((row) => [row.creator_id, row.latest_reach]));
    for (const creator of scored) {
      creator.latest_reach = reachByCreator.get(creator.id) ?? 0;
    }
  }

  scored.sort(compareCreators);
  const page = scored.slice(input.offset, input.offset + input.limit);
  if (page.length > 0) {
    const deliveries = await all<DeliveryRow>(
      db,
      `SELECT creator_id, COUNT(*) AS n FROM deliveries
       WHERE creator_id IN (SELECT value FROM json_each(?)) AND delivered_at >= ?
       GROUP BY creator_id`,
      JSON.stringify(page.map((creator) => creator.id)),
      deliveriesSince(),
    );
    const deliveriesByCreator = new Map(deliveries.map((row) => [row.creator_id, Number(row.n)]));
    for (const creator of page) {
      creator.deliveries_90d = deliveriesByCreator.get(creator.id) ?? 0;
    }
  }

  return {
    campaign_id: input.campaignId,
    total: scored.length,
    creators: page,
  };
}
