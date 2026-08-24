/**
 * subscription-teardown Lambda — runs on an EventBridge schedule (hourly).
 *
 * Finds sites that have sat "offline" (subscription ended, CloudFront
 * disabled) past the grace period, re-verifies directly against Stripe — not
 * just trusting DynamoDB — that there's still no active subscription for
 * that customer (guards against a missed reactivation webhook, the same
 * failure class the `reconciler` Lambda already exists to catch on the
 * checkout side), then starts the site_teardown Step Functions execution
 * that permanently deletes the site's hosting resources.
 *
 * A site's teardownStartedAt field is a lock shared with the backend's
 * owner-triggered POST /sites/:id/delete-now endpoint — both start
 * executions on the same site_teardown state machine, and the conditional
 * claim below prevents either path from double-starting an execution.
 *
 * Also runs an earlier warning pass, WARNING_DAYS_BEFORE_TEARDOWN days before
 * the grace period actually ends, that emails the owner via the backend's
 * internal endpoint — same "Lambda decides when, backend decides what"
 * pattern as the domain-renewal Lambda. Sites already claimed for teardown
 * (teardownStartedAt set) are skipped since a warning would be pointless.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules) plus
 * the Node 22 runtime's native fetch for the read-only Stripe API call and
 * the backend call.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { SFNClient, StartExecutionCommand } from "@aws-sdk/client-sfn";
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENV = process.env.ENV ?? "qa";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const SITE_TEARDOWN_STATE_MACHINE_ARN = process.env.SITE_TEARDOWN_STATE_MACHINE_ARN;
const GRACE_PERIOD_DAYS = Number(process.env.GRACE_PERIOD_DAYS ?? "90");
const GRACE_PERIOD_MS = GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const WARNING_DAYS_BEFORE_TEARDOWN = Number(process.env.WARNING_DAYS_BEFORE_TEARDOWN ?? "7");
const DAY_MS = 24 * 60 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sfn = new SFNClient({ region: REGION });
const cloudwatch = new CloudWatchClient({ region: REGION });

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

/** Sends the grace-period teardown warning to offline sites approaching (but
 * not yet past) the teardown cutoff, that haven't been warned or claimed for
 * teardown already. Returns the count notified. */
async function sendTeardownWarnings() {
  if (!BACKEND_INTERNAL_URL) {
    console.error("BACKEND_INTERNAL_URL unset — skipping teardown warnings");
    return 0;
  }

  const now = Date.now();
  // Sites older than warningCutoff are within WARNING_DAYS_BEFORE_TEARDOWN of
  // deletion; sites older than teardownCutoff have already crossed the full
  // grace period and are handled by the teardown-cutoff scan below instead —
  // excluding them here stops a "days remaining" email from going out the
  // same run a site is actually torn down.
  const warningCutoff = now - (GRACE_PERIOD_MS - WARNING_DAYS_BEFORE_TEARDOWN * DAY_MS);
  const teardownCutoff = now - GRACE_PERIOD_MS;
  let ExclusiveStartKey;
  let notified = 0;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: SITES_TABLE,
        ExclusiveStartKey,
        FilterExpression:
          "#s = :offline AND offlineAt < :warningCutoff AND offlineAt >= :teardownCutoff AND attribute_not_exists(teardownWarningSent) AND attribute_not_exists(teardownStartedAt)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":offline": "offline",
          ":warningCutoff": warningCutoff,
          ":teardownCutoff": teardownCutoff,
        },
      })
    );

    for (const site of res.Items || []) {
      const daysRemaining = Math.max(
        0,
        Math.ceil((site.offlineAt + GRACE_PERIOD_MS - now) / DAY_MS)
      );
      try {
        await callInternal("/internal/site-teardown-warning", { siteId: site.siteId, daysRemaining });
        await ddb.send(
          new UpdateCommand({
            TableName: SITES_TABLE,
            Key: { siteId: site.siteId },
            UpdateExpression: "SET teardownWarningSent = :true, updatedAt = :now",
            ExpressionAttributeValues: { ":true": true, ":now": now },
          })
        );
        notified++;
      } catch (err) {
        console.error(`teardown-warning notify failed for site ${site.siteId}: ${err}`);
      }
    }

    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return notified;
}

/** True if Stripe currently shows an active subscription for this customer. */
async function hasActiveSubscription(stripeCustomerId) {
  if (!stripeCustomerId) return false;
  const url = new URL("https://api.stripe.com/v1/subscriptions");
  url.searchParams.set("customer", stripeCustomerId);
  url.searchParams.set("status", "active");
  url.searchParams.set("limit", "1");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Stripe list subscriptions failed: ${res.status} ${await res.text()}`);
  }
  const body = await res.json();
  return (body.data || []).length > 0;
}

async function putMetric(name, count) {
  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "Cinderblock/SubscriptionTeardown",
      MetricData: [
        {
          MetricName: name,
          Dimensions: [{ Name: "env", Value: ENV }],
          Value: count,
          Unit: "Count",
        },
      ],
    })
  );
}

/** Conditional lock claim shared with POST /sites/:id/delete-now. Returns
 * false (without throwing) if another cycle/request already claimed it. */
async function claimTeardownLock(siteId) {
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: SITES_TABLE,
        Key: { siteId },
        UpdateExpression: "SET teardownStartedAt = :now",
        ConditionExpression: "attribute_not_exists(teardownStartedAt)",
        ExpressionAttributeValues: { ":now": Date.now() },
      })
    );
    return true;
  } catch (err) {
    if (err?.name === "ConditionalCheckFailedException") return false;
    throw err;
  }
}

async function releaseTeardownLock(siteId) {
  await ddb.send(
    new UpdateCommand({
      TableName: SITES_TABLE,
      Key: { siteId },
      UpdateExpression: "REMOVE teardownStartedAt",
    })
  );
}

export const handler = async () => {
  const warned = await sendTeardownWarnings();

  if (!SITE_TEARDOWN_STATE_MACHINE_ARN) {
    console.error("SITE_TEARDOWN_STATE_MACHINE_ARN unset — cannot start teardown executions");
    return { scanned: 0, tornDown: 0, unexpectedActive: 0, warned, skippedConfig: true };
  }

  const cutoff = Date.now() - GRACE_PERIOD_MS;
  let ExclusiveStartKey;
  let scanned = 0;
  let tornDown = 0;
  let unexpectedActive = 0;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: SITES_TABLE,
        ExclusiveStartKey,
        FilterExpression: "#s = :offline AND offlineAt < :cutoff",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":offline": "offline", ":cutoff": cutoff },
      })
    );

    for (const site of res.Items || []) {
      scanned++;
      if (site.teardownStartedAt) continue; // already claimed by a prior cycle or delete-now

      const claimed = await claimTeardownLock(site.siteId);
      if (!claimed) continue;

      try {
        const active = STRIPE_SECRET_KEY
          ? await hasActiveSubscription(site.stripeCustomerId)
          : false;

        if (active) {
          // Most likely a missed reactivation webhook. Don't auto-reactivate
          // here — keep that path single-entry (the webhook) — just release
          // the lock and alert so a human investigates.
          unexpectedActive++;
          console.error(
            "UNEXPECTED_ACTIVE_SUBSCRIPTION",
            JSON.stringify({ siteId: site.siteId, stripeCustomerId: site.stripeCustomerId })
          );
          await releaseTeardownLock(site.siteId);
          continue;
        }

        await sfn.send(
          new StartExecutionCommand({
            stateMachineArn: SITE_TEARDOWN_STATE_MACHINE_ARN,
            name: `teardown-${site.siteId}-${Date.now()}`,
            input: JSON.stringify({ siteId: site.siteId }),
          })
        );
        tornDown++;
        console.log(`Started teardown for site ${site.siteId}`);
      } catch (err) {
        console.warn(`Teardown sweep failed for site ${site.siteId}: ${err}`);
        await releaseTeardownLock(site.siteId).catch(() => {});
      }
    }

    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  await putMetric("TornDown", tornDown);
  await putMetric("UnexpectedActiveSubscription", unexpectedActive);

  console.log(
    `Subscription-teardown sweep complete. scanned=${scanned} tornDown=${tornDown} unexpectedActive=${unexpectedActive} warned=${warned}`
  );
  return { scanned, tornDown, unexpectedActive, warned };
};
