/**
 * cleanup Lambda — runs on an EventBridge schedule (hourly).
 *
 * Deletes the preview S3 bucket for any site that is still an unpaid preview
 * (status in building|preview|failed) and older than its 12h expiry, then marks
 * the record expired. This reclaims buckets from people who designed a site but
 * never paid. Paid sites (provisioning|live) are never touched.
 *
 * Also sends a "preview expiring soon" heads-up email — via the backend's
 * internal endpoint, same pattern as the domain-renewal Lambda — for any
 * status="preview" site inside the PREVIEW_HEADS_UP_MINUTES window that
 * hasn't been reminded yet, before it's swept up by the deletion pass above.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules) plus
 * the Node 22 runtime's native fetch for the backend call.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
const BACKEND_INTERNAL_URL = process.env.BACKEND_INTERNAL_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const PREVIEW_HEADS_UP_MINUTES = Number(process.env.PREVIEW_HEADS_UP_MINUTES ?? "60");
const MINUTE_MS = 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

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

/** Sends "preview expiring soon" to any viewable preview inside the heads-up
 * window that hasn't already been reminded. Returns the count notified. */
async function sendExpiringSoonReminders() {
  if (!BACKEND_INTERNAL_URL) {
    console.error("BACKEND_INTERNAL_URL unset — skipping preview-expiring-soon reminders");
    return 0;
  }

  const now = Date.now();
  const windowEnd = now + PREVIEW_HEADS_UP_MINUTES * MINUTE_MS;
  let ExclusiveStartKey;
  let notified = 0;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: SITES_TABLE,
        ExclusiveStartKey,
        FilterExpression:
          "#s = :preview AND expiresAt > :now AND expiresAt < :windowEnd AND attribute_not_exists(previewExpiryReminderSent)",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: { ":preview": "preview", ":now": now, ":windowEnd": windowEnd },
      })
    );

    for (const site of res.Items || []) {
      const hoursRemaining = Math.max(1, Math.ceil((site.expiresAt - now) / (60 * MINUTE_MS)));
      try {
        await callInternal("/internal/preview-expiring-soon", { siteId: site.siteId, hoursRemaining });
        await ddb.send(
          new UpdateCommand({
            TableName: SITES_TABLE,
            Key: { siteId: site.siteId },
            UpdateExpression: "SET previewExpiryReminderSent = :true, updatedAt = :now",
            ExpressionAttributeValues: { ":true": true, ":now": now },
          })
        );
        notified++;
      } catch (err) {
        console.error(`preview-expiring-soon notify failed for site ${site.siteId}: ${err}`);
      }
    }

    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return notified;
}

async function emptyAndDeleteBucket(bucket) {
  let ContinuationToken;
  do {
    const listed = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken })
    );
    const objects = (listed.Contents || []).map((o) => ({ Key: o.Key }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        })
      );
    }
    ContinuationToken = listed.IsTruncated
      ? listed.NextContinuationToken
      : undefined;
  } while (ContinuationToken);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}

export const handler = async () => {
  const reminded = await sendExpiringSoonReminders();

  const now = Date.now();
  const stale = new Set(["building", "preview", "failed"]);
  let ExclusiveStartKey;
  let deleted = 0;
  let scanned = 0;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: SITES_TABLE,
        ExclusiveStartKey,
        FilterExpression: "#s IN (:building, :preview, :failed) AND expiresAt < :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":building": "building",
          ":preview": "preview",
          ":failed": "failed",
          ":now": now,
        },
      })
    );

    for (const site of res.Items || []) {
      scanned++;
      if (!stale.has(site.status)) continue;
      if (site.previewBucket) {
        try {
          await emptyAndDeleteBucket(site.previewBucket);
        } catch (err) {
          console.warn(`Failed to delete bucket ${site.previewBucket}: ${err}`);
        }
      }
      await ddb.send(
        new UpdateCommand({
          TableName: SITES_TABLE,
          Key: { siteId: site.siteId },
          UpdateExpression:
            "SET #s = :expired, updatedAt = :now REMOVE previewUrl, previewBucket",
          ExpressionAttributeNames: { "#s": "status" },
          ExpressionAttributeValues: { ":expired": "expired", ":now": now },
        })
      );
      deleted++;
      console.log(`Expired site ${site.siteId} (${site.previewBucket || "no bucket"})`);
    }

    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  console.log(`Cleanup complete. scanned=${scanned} expired=${deleted} reminded=${reminded}`);
  return { scanned, expired: deleted, reminded };
};
