/**
 * cleanup Lambda — runs on an EventBridge schedule (hourly).
 *
 * Deletes the preview S3 bucket for any site that is still an unpaid preview
 * (status in building|preview|failed) and older than its 12h expiry, then marks
 * the record expired. This reclaims buckets from people who designed a site but
 * never paid. Paid sites (provisioning|live) are never touched.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules).
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

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });

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

  console.log(`Cleanup complete. scanned=${scanned} expired=${deleted}`);
  return { scanned, expired: deleted };
};
