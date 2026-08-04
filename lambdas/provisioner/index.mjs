/**
 * provisioner Lambda — the task handler for the Step Functions provisioning
 * pipeline that runs after a site is paid for. One handler, dispatched by a
 * `step` field; it loads/persists all intermediate state on the site record in
 * DynamoDB, so the state machine only ever passes { siteId, step }.
 *
 * Steps (see stepfunctions ASL):
 *   init             -> returns { siteId, domainOwned }
 *   registerDomain   -> Route 53 Domains RegisterDomain (stores operationId)
 *   checkDomain      -> poll operation -> { domainReady }
 *   ensureHostedZone -> find/create hosted zone (stores hostedZoneId)
 *   requestCert      -> ACM RequestCertificate + write DNS validation records
 *   checkCert        -> poll cert -> { certReady }
 *   buildSite        -> download the site's stored Astro source from its
 *                       preview bucket, `npm install && npm run build`, and
 *                       upload the fresh dist/ output back — production
 *                       always reflects the latest stored source regardless
 *                       of preview history
 *   createDistribution -> CloudFront OAC + distribution (stores distributionId)
 *   checkDist        -> poll distribution -> { distReady }
 *   writeAlias       -> Route 53 A-alias -> CloudFront
 *   lockBucket       -> block public access + OAC-only bucket policy
 *   markLive         -> status = live
 *   markFailed       -> status = failed
 *
 *   Sandbox pipeline (separate, shorter state machine — no domain/ACM/Route53,
 *   CloudFront's own default certificate covers the *.cloudfront.net domain):
 *   createSandboxDistribution -> CloudFront OAC + distribution over
 *                       cinderblock-sandbox-{siteId}-{env} (stores
 *                       sandboxBucket/sandboxDistributionId/sandboxOacId)
 *   checkSandboxDist -> poll distribution -> { sandboxDistReady }
 *   lockSandboxBucket -> block public access + OAC-only bucket policy
 *   markSandboxReady -> sandboxStatus = ready, sandboxDomain, sandboxUrl
 *   markSandboxFailed -> sandboxStatus = failed
 *   publishSandbox   -> mirror the sandbox bucket onto the live preview
 *                       bucket (copy + delete stale keys) and invalidate the
 *                       live CloudFront distribution. Run as a single async
 *                       Lambda invoke, not part of a state machine — no
 *                       eventual-consistency wait involved.
 *
 * Uses the AWS SDK v3 bundled in the Lambda runtime (no node_modules).
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  Route53DomainsClient,
  RegisterDomainCommand,
  GetOperationDetailCommand,
} from "@aws-sdk/client-route-53-domains";
import {
  Route53Client,
  ListHostedZonesByNameCommand,
  CreateHostedZoneCommand,
  GetHostedZoneCommand,
  ChangeResourceRecordSetsCommand,
} from "@aws-sdk/client-route-53";
import {
  ACMClient,
  RequestCertificateCommand,
  DescribeCertificateCommand,
} from "@aws-sdk/client-acm";
import {
  CloudFrontClient,
  CreateOriginAccessControlCommand,
  CreateDistributionCommand,
  GetDistributionCommand,
  CreateInvalidationCommand,
} from "@aws-sdk/client-cloudfront";
import {
  S3Client,
  PutPublicAccessBlockCommand,
  PutBucketPolicyCommand,
  ListObjectsV2Command,
  CopyObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { randomUUID } from "crypto";
import path from "node:path";
import {
  resetWorkspace,
  downloadSourceToWorkspace,
  runNpmInstallAndBuild,
  uploadDirToBucket,
} from "./buildAstro.mjs";

const REGION = process.env.AWS_REGION ?? "us-east-1";
const ENV = process.env.ENV ?? "qa";
const SITES_TABLE = process.env.SITES_TABLE ?? "cinderblock-sites-qa";
// CloudFront's fixed hosted-zone id for alias records (global constant).
const CLOUDFRONT_HZ = "Z2FDTNDATAQYW2";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const domains = new Route53DomainsClient({ region: "us-east-1" });
const route53 = new Route53Client({ region: "us-east-1" });
const acm = new ACMClient({ region: "us-east-1" }); // CloudFront requires us-east-1 certs
const cloudfront = new CloudFrontClient({ region: "us-east-1" });
const s3 = new S3Client({ region: REGION });

const loadSite = async (siteId) => {
  const res = await ddb.send(
    new GetCommand({ TableName: SITES_TABLE, Key: { siteId } })
  );
  if (!res.Item) throw new Error(`site ${siteId} not found`);
  return res.Item;
};

const patchSite = (siteId, sets, values, names) =>
  ddb.send(
    new UpdateCommand({
      TableName: SITES_TABLE,
      Key: { siteId },
      UpdateExpression: "SET " + sets.join(", "),
      ExpressionAttributeValues: { ...values, ":now": Date.now() },
      ...(names ? { ExpressionAttributeNames: names } : {}),
    })
  );

function contactFrom(rc) {
  return {
    FirstName: rc.firstName,
    LastName: rc.lastName,
    ContactType: "PERSON",
    AddressLine1: rc.addressLine1,
    City: rc.city,
    State: rc.state,
    CountryCode: rc.countryCode,
    ZipCode: rc.zipCode,
    PhoneNumber: rc.phoneNumber,
    Email: rc.email,
  };
}

const steps = {
  async init(site) {
    return { siteId: site.siteId, domainOwned: !!site.domainOwned };
  },

  async registerDomain(site) {
    if (!site.registrantContact)
      throw new Error("registrantContact missing for domain registration");
    const contact = contactFrom(site.registrantContact);
    const res = await domains.send(
      new RegisterDomainCommand({
        DomainName: site.domain,
        DurationInYears: 1,
        AutoRenew: true,
        AdminContact: contact,
        RegistrantContact: contact,
        TechContact: contact,
        PrivacyProtectAdminContact: true,
        PrivacyProtectRegistrantContact: true,
        PrivacyProtectTechContact: true,
      })
    );
    await patchSite(
      site.siteId,
      ["domainOperationId = :op", "updatedAt = :now"],
      { ":op": res.OperationId }
    );
    return { siteId: site.siteId };
  },

  async checkDomain(site) {
    if (!site.domainOperationId) return { siteId: site.siteId, domainReady: true };
    const res = await domains.send(
      new GetOperationDetailCommand({ OperationId: site.domainOperationId })
    );
    if (res.Status === "ERROR" || res.Status === "FAILED")
      throw new Error(`domain registration failed: ${res.Message}`);
    return { siteId: site.siteId, domainReady: res.Status === "SUCCESSFUL" };
  },

  async ensureHostedZone(site) {
    const name = site.domain.endsWith(".") ? site.domain : site.domain + ".";
    const listed = await route53.send(
      new ListHostedZonesByNameCommand({ DNSName: name })
    );
    let zone = (listed.HostedZones || []).find(
      (z) => z.Name === name && !z.Config?.PrivateZone
    );
    let hostedZoneId = zone?.Id?.replace("/hostedzone/", "");
    if (!hostedZoneId) {
      const created = await route53.send(
        new CreateHostedZoneCommand({
          Name: site.domain,
          CallerReference: `cinderblock-${site.siteId}-${Date.now()}`,
        })
      );
      hostedZoneId = created.HostedZone?.Id?.replace("/hostedzone/", "");
    }
    // Fetch fresh regardless of branch: CreateHostedZoneCommand returns a
    // delegation set, but a pre-existing zone (found via List) does not.
    const got = await route53.send(
      new GetHostedZoneCommand({ Id: hostedZoneId })
    );
    const nameServers = got.DelegationSet?.NameServers || [];
    await patchSite(
      site.siteId,
      ["hostedZoneId = :hz", "nameServers = :ns", "updatedAt = :now"],
      { ":hz": hostedZoneId, ":ns": nameServers }
    );
    return { siteId: site.siteId };
  },

  async requestCert(site) {
    const res = await acm.send(
      new RequestCertificateCommand({
        DomainName: site.domain,
        SubjectAlternativeNames: [`www.${site.domain}`],
        ValidationMethod: "DNS",
        IdempotencyToken: `cb${site.siteId.replace(/-/g, "").slice(0, 28)}`,
      })
    );
    const certArn = res.CertificateArn;

    // DomainValidationOptions.ResourceRecord appears a few seconds after request.
    let records = [];
    for (let i = 0; i < 10; i++) {
      const desc = await acm.send(
        new DescribeCertificateCommand({ CertificateArn: certArn })
      );
      const opts = desc.Certificate?.DomainValidationOptions || [];
      records = opts
        .map((o) => o.ResourceRecord)
        .filter((r) => r && r.Name && r.Value);
      if (records.length) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!records.length)
      throw new Error("ACM did not return DNS validation records in time");

    // De-duplicate (apex + www often share a record) and UPSERT into the zone.
    const seen = new Set();
    const changes = [];
    for (const r of records) {
      if (seen.has(r.Name)) continue;
      seen.add(r.Name);
      changes.push({
        Action: "UPSERT",
        ResourceRecordSet: {
          Name: r.Name,
          Type: r.Type || "CNAME",
          TTL: 300,
          ResourceRecords: [{ Value: r.Value }],
        },
      });
    }
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: site.hostedZoneId,
        ChangeBatch: { Changes: changes },
      })
    );

    await patchSite(
      site.siteId,
      ["certArn = :c", "updatedAt = :now"],
      { ":c": certArn }
    );
    return { siteId: site.siteId };
  },

  async checkCert(site) {
    const desc = await acm.send(
      new DescribeCertificateCommand({ CertificateArn: site.certArn })
    );
    const status = desc.Certificate?.Status;
    if (status === "FAILED" || status === "VALIDATION_TIMED_OUT")
      throw new Error(`certificate ${status}`);
    return { siteId: site.siteId, certReady: status === "ISSUED" };
  },

  async buildSite(site, event, context) {
    const bucket = site.previewBucket;
    if (!bucket) throw new Error("previewBucket missing");

    const workspaceDir = `/tmp/build/${site.siteId}`;
    resetWorkspace(workspaceDir);
    await downloadSourceToWorkspace(s3, bucket, workspaceDir, { excludePrefixes: ["dist"] });

    const remainingMs = context?.getRemainingTimeInMillis?.() ?? 480_000;
    runNpmInstallAndBuild(workspaceDir, {
      timeoutMs: Math.max(60_000, Math.floor(remainingMs / 2) - 15_000),
    });

    await uploadDirToBucket(s3, bucket, path.join(workspaceDir, "dist"), "dist");
    return { siteId: site.siteId };
  },

  async createDistribution(site) {
    const bucket = site.previewBucket;
    if (!bucket) throw new Error("previewBucket missing");
    const originDomain = `${bucket}.s3.${REGION}.amazonaws.com`;

    const oac = await cloudfront.send(
      new CreateOriginAccessControlCommand({
        OriginAccessControlConfig: {
          Name: `cinderblock-${site.siteId}`,
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      })
    );
    const oacId = oac.OriginAccessControl?.Id;
    const originId = `s3-${bucket}`;

    const dist = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: `cinderblock-${site.siteId}-${randomUUID()}`,
          Comment: `Cinderblock ${site.domain}`,
          Enabled: true,
          Aliases: { Quantity: 2, Items: [site.domain, `www.${site.domain}`] },
          DefaultRootObject: "dist/index.html",
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: originId,
                DomainName: originDomain,
                OriginAccessControlId: oacId,
                S3OriginConfig: { OriginAccessIdentity: "" },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: originId,
            ViewerProtocolPolicy: "redirect-to-https",
            Compress: true,
            AllowedMethods: {
              Quantity: 2,
              Items: ["GET", "HEAD"],
              CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
            },
            // CachingOptimized managed policy id (AWS-global constant).
            CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
          },
          CustomErrorResponses: {
            Quantity: 1,
            Items: [
              {
                ErrorCode: 403,
                ResponseCode: "200",
                ResponsePagePath: "/dist/index.html",
                ErrorCachingMinTTL: 10,
              },
            ],
          },
          ViewerCertificate: {
            ACMCertificateArn: site.certArn,
            SSLSupportMethod: "sni-only",
            MinimumProtocolVersion: "TLSv1.2_2021",
          },
          PriceClass: "PriceClass_100",
        },
      })
    );

    await patchSite(
      site.siteId,
      [
        "distributionId = :id",
        "cloudfrontDomain = :dn",
        "oacId = :oac",
        "updatedAt = :now",
      ],
      {
        ":id": dist.Distribution?.Id,
        ":dn": dist.Distribution?.DomainName,
        ":oac": oacId,
      }
    );
    return { siteId: site.siteId };
  },

  async checkDist(site) {
    const res = await cloudfront.send(
      new GetDistributionCommand({ Id: site.distributionId })
    );
    return {
      siteId: site.siteId,
      distReady: res.Distribution?.Status === "Deployed",
    };
  },

  async writeAlias(site) {
    const target = {
      HostedZoneId: CLOUDFRONT_HZ,
      DNSName: site.cloudfrontDomain,
      EvaluateTargetHealth: false,
    };
    const changes = [site.domain, `www.${site.domain}`].map((name) => ({
      Action: "UPSERT",
      ResourceRecordSet: { Name: name, Type: "A", AliasTarget: target },
    }));
    await route53.send(
      new ChangeResourceRecordSetsCommand({
        HostedZoneId: site.hostedZoneId,
        ChangeBatch: { Changes: changes },
      })
    );
    return { siteId: site.siteId };
  },

  async lockBucket(site) {
    const bucket = site.previewBucket;
    // Re-enable public-access block, then grant read only to this distribution
    // via the OAC SourceArn condition (account id parsed from the cert ARN).
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false, // policy below is not "public" (has a condition)
          RestrictPublicBuckets: false,
        },
      })
    );
    const distArn = `arn:aws:cloudfront::${(site.certArn || "").split(":")[4]}:distribution/${site.distributionId}`;
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowCloudFrontOAC",
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: `arn:aws:s3:::${bucket}/*`,
              Condition: { StringEquals: { "AWS:SourceArn": distArn } },
            },
          ],
        }),
      })
    );
    return { siteId: site.siteId };
  },

  async markLive(site) {
    await patchSite(
      site.siteId,
      ["#s = :live", "previewUrl = :url", "updatedAt = :now"],
      {
        ":live": "live",
        ":url": `https://${site.cloudfrontDomain}/dist/index.html`,
      },
      { "#s": "status" }
    );
    return { siteId: site.siteId, status: "live" };
  },

  async markFailed(site, event) {
    const msg =
      typeof event?.error === "object"
        ? JSON.stringify(event.error).slice(0, 500)
        : String(event?.error || "provisioning failed");
    await patchSite(
      site.siteId,
      ["#s = :failed", "#err = :e", "updatedAt = :now"],
      { ":failed": "failed", ":e": msg },
      { "#s": "status", "#err": "error" }
    );
    return { siteId: site.siteId, status: "failed" };
  },

  // -- Sandbox pipeline -----------------------------------------------------

  async createSandboxDistribution(site) {
    // Idempotent: a revise triggered while an earlier sandbox pipeline
    // execution is still in flight (or re-triggered later) must not create a
    // second distribution.
    if (site.sandboxDistributionId) return { siteId: site.siteId };

    const bucket = `cinderblock-sandbox-${site.siteId}-${ENV}`;
    const originDomain = `${bucket}.s3.${REGION}.amazonaws.com`;

    const oac = await cloudfront.send(
      new CreateOriginAccessControlCommand({
        OriginAccessControlConfig: {
          Name: `cinderblock-sandbox-${site.siteId}`,
          OriginAccessControlOriginType: "s3",
          SigningBehavior: "always",
          SigningProtocol: "sigv4",
        },
      })
    );
    const oacId = oac.OriginAccessControl?.Id;
    const originId = `s3-${bucket}`;

    const dist = await cloudfront.send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: `cinderblock-sandbox-${site.siteId}-${randomUUID()}`,
          Comment: `Cinderblock sandbox for ${site.domain}`,
          Enabled: true,
          DefaultRootObject: "dist/index.html",
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: originId,
                DomainName: originDomain,
                OriginAccessControlId: oacId,
                S3OriginConfig: { OriginAccessIdentity: "" },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: originId,
            ViewerProtocolPolicy: "redirect-to-https",
            Compress: true,
            AllowedMethods: {
              Quantity: 2,
              Items: ["GET", "HEAD"],
              CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] },
            },
            // CachingOptimized managed policy id (AWS-global constant).
            CachePolicyId: "658327ea-f89d-4fab-a63d-7e88639e58f6",
          },
          CustomErrorResponses: {
            Quantity: 1,
            Items: [
              {
                ErrorCode: 403,
                ResponseCode: "200",
                ResponsePagePath: "/dist/index.html",
                ErrorCachingMinTTL: 10,
              },
            ],
          },
          // No custom domain for a sandbox — CloudFront's own default
          // certificate already covers *.cloudfront.net, so no ACM cert or
          // Route 53 wiring is needed here (unlike the live pipeline).
          ViewerCertificate: { CloudFrontDefaultCertificate: true },
          PriceClass: "PriceClass_100",
        },
      })
    );

    await patchSite(
      site.siteId,
      [
        "sandboxBucket = :b",
        "sandboxDistributionId = :id",
        "sandboxOacId = :oac",
        "sandboxDomain = :d",
        "sandboxStatus = :s",
        "updatedAt = :now",
      ],
      {
        ":b": bucket,
        ":id": dist.Distribution?.Id,
        ":oac": oacId,
        ":d": dist.Distribution?.DomainName,
        ":s": "provisioning",
      }
    );
    return { siteId: site.siteId };
  },

  async checkSandboxDist(site) {
    const res = await cloudfront.send(
      new GetDistributionCommand({ Id: site.sandboxDistributionId })
    );
    return {
      siteId: site.siteId,
      sandboxDistReady: res.Distribution?.Status === "Deployed",
    };
  },

  async lockSandboxBucket(site, event, context) {
    const bucket = site.sandboxBucket;
    if (!bucket) throw new Error("sandboxBucket missing");
    await s3.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucket,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: false, // policy below is not "public" (has a condition)
          RestrictPublicBuckets: false,
        },
      })
    );
    // No ACM cert on a sandbox distribution to pull the account id from (see
    // lockBucket above) — the Lambda's own invoked-function ARN always has it.
    const accountId = context?.invokedFunctionArn?.split(":")[4];
    const distArn = `arn:aws:cloudfront::${accountId}:distribution/${site.sandboxDistributionId}`;
    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket,
        Policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Sid: "AllowCloudFrontOAC",
              Effect: "Allow",
              Principal: { Service: "cloudfront.amazonaws.com" },
              Action: "s3:GetObject",
              Resource: `arn:aws:s3:::${bucket}/*`,
              Condition: { StringEquals: { "AWS:SourceArn": distArn } },
            },
          ],
        }),
      })
    );
    return { siteId: site.siteId };
  },

  async markSandboxReady(site) {
    if (!site.sandboxDomain) throw new Error("sandboxDomain missing");
    await patchSite(
      site.siteId,
      ["sandboxStatus = :s", "sandboxUrl = :u", "updatedAt = :now"],
      {
        ":s": "ready",
        ":u": `https://${site.sandboxDomain}/dist/index.html`,
      }
    );
    return { siteId: site.siteId, sandboxStatus: "ready" };
  },

  async markSandboxFailed(site, event) {
    const msg =
      typeof event?.error === "object"
        ? JSON.stringify(event.error).slice(0, 500)
        : String(event?.error || "sandbox provisioning failed");
    await patchSite(
      site.siteId,
      ["sandboxStatus = :failed", "sandboxError = :e", "updatedAt = :now"],
      { ":failed": "failed", ":e": msg }
    );
    return { siteId: site.siteId, sandboxStatus: "failed" };
  },

  /**
   * Mirrors the sandbox bucket onto the live preview bucket (copy every
   * sandbox key, delete any live key the sandbox no longer has) and
   * invalidates the live CloudFront distribution. Runs synchronously inside
   * one Lambda invoke — no eventual-consistency wait like cert/domain/
   * distribution provisioning needs, so no state machine involved.
   */
  async publishSandbox(site) {
    const sandboxBucket = site.sandboxBucket;
    const liveBucket = site.previewBucket;
    if (!sandboxBucket) throw new Error("sandboxBucket missing");
    if (!liveBucket) throw new Error("previewBucket missing");
    if (!site.distributionId) throw new Error("distributionId missing");

    const sandboxKeys = await listAllKeys(sandboxBucket);
    const liveKeys = await listAllKeys(liveBucket);

    for (const key of sandboxKeys) {
      await s3.send(
        new CopyObjectCommand({
          Bucket: liveBucket,
          CopySource: `/${sandboxBucket}/${encodeURIComponent(key)}`,
          Key: key,
          MetadataDirective: "COPY",
        })
      );
    }

    const staleKeys = liveKeys.filter((k) => !sandboxKeys.includes(k));
    for (let i = 0; i < staleKeys.length; i += 1000) {
      const batch = staleKeys.slice(i, i + 1000);
      if (!batch.length) continue;
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: liveBucket,
          Delete: { Objects: batch.map((Key) => ({ Key })) },
        })
      );
    }

    await cloudfront.send(
      new CreateInvalidationCommand({
        DistributionId: site.distributionId,
        InvalidationBatch: {
          CallerReference: `publish-${site.siteId}-${Date.now()}`,
          Paths: { Quantity: 1, Items: ["/*"] },
        },
      })
    );

    await patchSite(
      site.siteId,
      ["sandboxStatus = :s", "updatedAt = :now"],
      { ":s": "ready" }
    );
    return { siteId: site.siteId, sandboxStatus: "ready", published: true };
  },
};

async function listAllKeys(bucket) {
  const keys = [];
  let ContinuationToken;
  do {
    const res = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken })
    );
    for (const obj of res.Contents || []) keys.push(obj.Key);
    ContinuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return keys;
}

export const handler = async (event, context) => {
  const { siteId, step } = event || {};
  if (!siteId || !step) throw new Error("siteId and step are required");
  const fn = steps[step];
  if (!fn) throw new Error(`unknown step: ${step}`);
  const site = await loadSite(siteId);
  console.log(`provisioner step=${step} site=${siteId} status=${site.status}`);
  return fn(site, event, context);
};
