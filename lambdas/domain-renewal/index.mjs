/**
 * domain-renewal Lambda — runs daily on an EventBridge schedule.
 *
 * Scans for domains Cinderblock registered on the customer's behalf
 * (domainOwned=false — see disableDomainAutoRenew in the provisioner Lambda
 * for the same convention; domainOwned=true means the customer already
 * owned the domain elsewhere and Cinderblock never registered or bills for
 * it, so those sites are skipped entirely), refreshes their
 * Route 53 Domains expiration date when it's missing or inside the lookahead
 * window (catches drift: a registrar-side auto-renewal or manual renewal
 * pushing the date out), and for each site crossing a heads-up or
 * charge-attempt threshold it hasn't already handled, calls the backend's
 * shared-secret-authenticated internal endpoint to render + send the branded
 * email and, at the charge threshold, attempt the off-session Stripe charge.
 *
 * This Lambda never talks to SES or Stripe directly — the backend owns that
 * (it holds the full-write STRIPE_SECRET_KEY and the React Email templates).
 * This Lambda only decides *when*; the backend decides *what*.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules) plus
 * the Node 22 runtime's native fetch for the backend call, matching the
 * reconciler/provisioner convention of zero third-party dependencies.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  Route53DomainsClient,
  GetDomainDetailCommand,
} from "@aws-sdk/client-route-53-domains";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENV = process.env.ENV ?? "qa";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

const HEADS_UP_DAYS = (process.env.HEADS_UP_DAYS ?? "14,7")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => b - a); // largest window first
const CHARGE_ATTEMPT_DAYS = (process.env.CHARGE_ATTEMPT_DAYS ?? "3")
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => b - a);

// Refresh GetDomainDetail for any owned domain inside this window (or with no
// expiration on record yet) rather than every site every day — cheap enough
// at Cinderblock's current volume and catches drift right when it matters.
const REFRESH_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const domains = new Route53DomainsClient({ region: "us-east-1" }); // Route 53 Domains only exists in us-east-1
const cloudwatch = new CloudWatchClient({ region: REGION });

async function scanCinderblockRegisteredDomainSites() {
  const sites = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: SITES_TABLE,
        // domainOwned=false: Cinderblock registered this domain via Route 53
        // and is on the hook for its renewal cost — see the module comment.
        FilterExpression: "domainOwned = :false AND #s = :live",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":false": false, ":live": "live" },
        ExclusiveStartKey,
      })
    );
    sites.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return sites;
}

async function refreshExpiration(site) {
  try {
    const res = await domains.send(
      new GetDomainDetailCommand({ DomainName: site.domain })
    );
    const expiresAt = res.ExpirationDate ? new Date(res.ExpirationDate).getTime() : undefined;
    const autoRenew = res.AutoRenew;
    if (expiresAt) {
      await ddb.send(
        new UpdateCommand({
          TableName: SITES_TABLE,
          Key: { siteId: site.siteId },
          UpdateExpression:
            "SET domainExpiresAt = :exp, domainAutoRenewEnabled = :ar, updatedAt = :now",
          ExpressionAttributeValues: {
            ":exp": expiresAt,
            ":ar": !!autoRenew,
            ":now": Date.now(),
          },
        })
      );
      site.domainExpiresAt = expiresAt;
      site.domainAutoRenewEnabled = !!autoRenew;
    }
  } catch (err) {
    console.warn(`GetDomainDetail failed for ${site.domain}: ${err}`);
  }
}

async function markThresholdHandled(siteId, marker) {
  await ddb.send(
    new UpdateCommand({
      TableName: SITES_TABLE,
      Key: { siteId },
      UpdateExpression:
        "SET domainRenewalRemindersSent = list_append(if_not_exists(domainRenewalRemindersSent, :empty), :marker), updatedAt = :now",
      ExpressionAttributeValues: {
        ":empty": [],
        ":marker": [marker],
        ":now": Date.now(),
      },
    })
  );
}

async function callInternal(path, body) {
  const res = await fetch(`${BACKEND_INTERNAL_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Internal-Secret": INTERNAL_API_SECRET ?? "",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.json().catch(() => ({}));
}

async function putProcessedMetric(count) {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "Cinderblock/DomainRenewal",
      MetricData: [
        {
          MetricName: "RemindersSent",
          Dimensions: [{ Name: "env", Value: ENV }],
          Value: count,
          Unit: "Count",
        },
      ],
    })
  );
}

export const handler = async () => {
  if (!BACKEND_INTERNAL_URL) {
    console.error("BACKEND_INTERNAL_URL unset — cannot notify the backend");
    await putProcessedMetric(0);
    return { scanned: 0, notified: 0, skippedConfig: true };
  }

  const sites = await scanCinderblockRegisteredDomainSites();
  const now = Date.now();
  let notified = 0;

  for (const site of sites) {
    const needsRefresh =
      !site.domainExpiresAt ||
      site.domainExpiresAt - now < REFRESH_WINDOW_DAYS * DAY_MS;
    if (needsRefresh) await refreshExpiration(site);
    if (!site.domainExpiresAt) continue;

    const daysRemaining = Math.floor((site.domainExpiresAt - now) / DAY_MS);
    const sent = new Set(site.domainRenewalRemindersSent ?? []);

    for (const days of HEADS_UP_DAYS) {
      const marker = `heads-up-${days}`;
      if (daysRemaining > days || sent.has(marker)) continue;
      try {
        await callInternal("/internal/domain-renewal-heads-up", {
          siteId: site.siteId,
          daysRemaining,
        });
        await markThresholdHandled(site.siteId, marker);
        notified++;
      } catch (err) {
        console.error(`heads-up notify failed for site ${site.siteId}: ${err}`);
      }
    }

    for (const days of CHARGE_ATTEMPT_DAYS) {
      const marker = `charge-${days}`;
      if (daysRemaining > days || sent.has(marker)) continue;
      if (site.domainRenewalChargeStatus === "succeeded") continue;
      try {
        await callInternal("/internal/domain-renewal-charge", {
          siteId: site.siteId,
        });
        await markThresholdHandled(site.siteId, marker);
        notified++;
      } catch (err) {
        console.error(`charge attempt failed for site ${site.siteId}: ${err}`);
      }
    }
  }

  await putProcessedMetric(notified);
  console.log(`Domain renewal sweep complete. scanned=${sites.length} notified=${notified}`);
  return { scanned: sites.length, notified };
};
