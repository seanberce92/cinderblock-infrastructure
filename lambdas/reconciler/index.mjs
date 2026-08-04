/**
 * reconciler Lambda — runs on an EventBridge schedule (every 15 min).
 *
 * Early-warning system for a broken Stripe webhook (the exact class of bug
 * that let paid customers sit un-provisioned with no visible error): treats
 * Stripe, not DynamoDB, as the source of truth for "did a checkout complete."
 * Lists recently-completed Checkout Sessions directly from the Stripe API
 * and checks whether each one's site ever left building/preview status. A
 * site stuck there well past normal webhook + Step Functions latency means
 * `checkout.session.completed` never reached (or never finished processing
 * in) POST /webhooks/stripe.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules) plus
 * the Node 22 runtime's native fetch for the read-only Stripe API call, so
 * this Lambda needs no third-party dependencies to package.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENV = process.env.ENV ?? "qa";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

// Give the webhook + Step Functions normal path this long before a still-not-
// provisioning site counts as "stuck" rather than "just in flight."
const STUCK_THRESHOLD_MS = 20 * 60 * 1000;
// Only look at sessions from within this window, so a single missed run
// doesn't lose track of a session (window > schedule period) but we're not
// re-scanning Stripe's entire history every invocation either.
const LOOKBACK_MS = 60 * 60 * 1000;
const UNRESOLVED_STATUSES = new Set(["building", "preview"]);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const cloudwatch = new CloudWatchClient({ region: REGION });

async function listCompletedSessions(sinceEpochSeconds) {
  const sessions = [];
  let startingAfter;

  do {
    const url = new URL("https://api.stripe.com/v1/checkout/sessions");
    url.searchParams.set("status", "complete");
    url.searchParams.set("limit", "100");
    url.searchParams.set("created[gte]", String(sinceEpochSeconds));
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    if (!res.ok) {
      throw new Error(`Stripe list sessions failed: ${res.status} ${await res.text()}`);
    }
    const body = await res.json();
    sessions.push(...body.data);
    startingAfter = body.has_more ? body.data[body.data.length - 1]?.id : undefined;
  } while (startingAfter);

  return sessions;
}

async function putStuckCheckoutsMetric(count) {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "Cinderblock/Reconciler",
      MetricData: [
        {
          MetricName: "StuckCheckouts",
          Dimensions: [{ Name: "env", Value: ENV }],
          Value: count,
          Unit: "Count",
        },
      ],
    })
  );
}

export const handler = async () => {
  if (!STRIPE_SECRET_KEY) {
    console.error("STRIPE_SECRET_KEY unset — cannot reconcile checkout sessions");
    // Emit a datapoint anyway so the metric doesn't go INSUFFICIENT_DATA and
    // silently stop alerting just because this Lambda is misconfigured.
    await putStuckCheckoutsMetric(0);
    return { checked: 0, stuck: 0, skippedConfig: true };
  }

  const now = Date.now();
  const sessions = await listCompletedSessions(Math.floor((now - LOOKBACK_MS) / 1000));

  let checked = 0;
  let stuck = 0;

  for (const session of sessions) {
    const siteId = session.client_reference_id;
    if (!siteId) continue;

    const ageMs = now - session.created * 1000;
    if (ageMs < STUCK_THRESHOLD_MS) continue; // still within normal latency

    checked++;

    const res = await ddb.send(
      new GetCommand({ TableName: SITES_TABLE, Key: { siteId } })
    );
    const site = res.Item;
    if (!site) {
      console.warn(`STUCK_PROVISIONING: session ${session.id} references unknown site ${siteId}`);
      continue;
    }

    if (UNRESOLVED_STATUSES.has(site.status)) {
      stuck++;
      console.error(
        "STUCK_PROVISIONING",
        JSON.stringify({
          siteId,
          sessionId: session.id,
          status: site.status,
          ageMinutes: Math.round(ageMs / 60000),
        })
      );
    }
  }

  await putStuckCheckoutsMetric(stuck);

  console.log(`Reconciler complete. checked=${checked} stuck=${stuck}`);
  return { checked, stuck };
};
