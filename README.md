# cinderblock-infrastructure

Terraform + worker Lambdas for Cinderblock (the AI static-site builder). Owns the
stateful and asynchronous pieces; the HTTP API (NestJS) lives in
`../cinderblock-backend` (SST). Conventions mirror `voice-agent-project/aws-infrastructure`:
a root `qa/` env dir + reusable `modules/`, a `common-labels` module carrying
`env`/`region`, and `build-lambda.sh` packaging. **State is local** (no S3/Dynamo
backend) — same as the reference; add a remote backend before multi-operator use.

Every resource follows the naming convention **`cinderblock-{resource}-{env}`**.
Only the **qa** environment exists today.

## What it provisions

| Module | Resources |
| --- | --- |
| `auth` | Cognito user pool + SPA client (`cinderblock-user-pool-qa`) |
| `data` | DynamoDB `cinderblock-users-qa`, `cinderblock-sites-qa` (GSI `userId-index`); private `cinderblock-uploads-qa` bucket |
| `workers` | `cinderblock-site-builder-qa`, `cinderblock-cleanup-qa` (+ hourly EventBridge rule), `cinderblock-provisioner-qa`, and the `cinderblock-provisioning-qa` Step Functions state machine + IAM |
| `certs` | ACM certs (DNS-validated) for the frontend and API custom domains |
| `frontend-hosting` | Private S3 bucket + CloudFront (OAC) serving the frontend SPA |
| `api-domain` | API Gateway v2 custom domain + mapping onto the SST-managed API |

Per-site public preview buckets (`cinderblock-preview-{siteId}-qa`) are created at
runtime by the site-builder Lambda and deleted by the cleanup Lambda — they are
not Terraform-managed.

## Lambdas (`lambdas/`)

Node.js 22, ES modules, **no dependencies** — they use the AWS SDK v3 bundled in
the Lambda runtime, so `build-lambda.sh` just zips the source.

- `site-builder` — Bedrock → JSON site spec → static `index.html`/`styles.css` →
  public preview bucket. Falls back to a deterministic spec if Bedrock is
  unavailable, so a build always produces a site.
- `cleanup` — hourly; deletes abandoned (unpaid, >12h) preview buckets.
- `provisioner` — Step Functions task handler: Route 53 domain registration →
  ACM DNS cert → CloudFront (OAC) → Route 53 alias → S3 lockdown → `live`.

## Deployment

### Local setup

Prerequisite: **enable Bedrock model access** for the configured model in the AWS
console (Bedrock → Model access) once per account.

Optional prerequisite: to ground generated sites in real Google Business
Profile data (hours/phone/address/social links), create a Google Cloud
project with **Maps Grounding Lite** and **Places API (New)** enabled and
billing on, then set `google_maps_api_key` in `terraform.tfvars` (see
`qa/terraform.tfvars.example`). Without it, the site-builder just skips GBP
grounding.

`terraform init` in `qa/` and AWS credentials for the `terraform-qa` IAM user
(a deliberately locked-down service account — see the IAM reference below for
what it can and can't do) are the only other prerequisites.

### QA deployment

Core infra:

```bash
./build-lambda.sh          # zip the three lambdas
./plan-qa.sh               # review the plan (also builds zips)
./apply-qa.sh              # apply (interactive)
# or: CI=true ./apply-qa-auto.sh
cd qa && terraform output  # copy values into the backend/frontend .env files
```

Feed `terraform output` into:
- `cinderblock-backend/.env`: `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`,
  `USERS_TABLE`, `SITES_TABLE`, `UPLOADS_BUCKET`, `SITE_BUILDER_FUNCTION_NAME`,
  `PROVISIONING_STATE_MACHINE_ARN`.
- `cinderblock-frontend/.env`: `VITE_COGNITO_USER_POOL_ID`, `VITE_COGNITO_CLIENT_ID`.

**Custom domains + frontend hosting** (`qa.cinderblock.site` /
`api-qa.cinderblock.site`), applied in this order because of real
dependencies between the modules:

1. `terraform apply -target=module.certs` — requests both ACM certs (DNS
   validation). **Gotcha:** the `aws_acm_certificate_validation` resources
   block until the validation CNAMEs are visible in DNS — `cinderblock.site`
   is on Namecheap, not Route 53, so nothing auto-creates them. Get the exact
   records via `terraform output -json certs_namecheap_dns_checklist` (only
   populated after a *successful* full apply — if you cancelled a hung
   apply, pull them instead via
   `terraform state show module.certs.aws_acm_certificate.<frontend|api>`,
   which has `domain_validation_options` populated as soon as the cert is
   requested, before validation completes). Add the CNAMEs at Namecheap,
   confirm with `dig CNAME <record> +short`, then re-run the same
   `-target=module.certs` apply.
2. `terraform apply -target=module.frontend-hosting` — S3 + CloudFront.
3. `terraform apply -target=module.api-domain` — needs the **existing**
   SST-deployed API's id (`var.api_gateway_id` in `terraform.tfvars`), not a
   new API — this module only attaches a domain to the API Gateway HTTP API
   that `cinderblock-backend/sst.config.ts` already created.
   `sst.config.ts` is never modified for this; the id is the subdomain
   segment of the SST `apiUrl` output / `backend_internal_url` tfvar (e.g.
   `v9zc7u2c9k` from `https://v9zc7u2c9k.execute-api...`).
4. Add the two live-traffic CNAMEs at Namecheap (`qa` →
   `frontend_distribution_domain_name` output, `api-qa` →
   `api_domain_target` output).

**Gotcha — always use `-target` for now.** The worker Lambda zips (`cleanup`,
`provisioner`, `subscription_teardown`, `cognito_email_sender`) have an
unstable `source_code_hash`, so an untargeted `terraform apply` shows them as
"changed" every time even with no real code change (tracked in the root
`TODO.md`, not fixed here). Until that's fixed, scope applies to the module
you're actually touching so you don't unintentionally redeploy Lambda code.

### Production (future)

Anticipated shape: a new `prod/` directory mirroring `qa/` (everything here
is already parameterized on `env` for exactly this — "a prod/ dir would be a
near-copy"), new resource names under `cinderblock-{resource}-prod`, and new
ACM certs / S3 bucket / CloudFront distribution / API Gateway domain for
whatever the prod hostnames end up being.

**Do not treat this as ready to run yet** — the SST removal-protection bug
tracked in the root `TODO.md` (stage name mismatch) must be resolved first,
since prod is exactly the environment that bug would bite.

## Custom domain setup — IAM reference

Setting up `qa.cinderblock.site`/`api-qa.cinderblock.site` required adding
permissions to the `terraform-qa` user's policy in three rounds of
trial-and-error. Recorded here so a `prod/` rollout doesn't repeat it —
which policy these actually live in wasn't tracked (a one-time addition, not
needed again for qa), so add the below to whichever policy grants
`terraform-qa` general resource-creation permissions.

**Already one-time, account-wide — nothing to redo for prod:**
- `acm:RequestCertificate` (Resource `*` — ACM doesn't support
  resource-level scoping for this action)
- `acm:DescribeCertificate` / `DeleteCertificate` / `AddTagsToCertificate` /
  `RemoveTagsFromCertificate` / `ListTagsForCertificate` on
  `arn:aws:acm:us-east-1:743281635965:certificate/*` (wildcard already
  covers future certs)
- `cloudfront:CreateOriginAccessControl` / `GetOriginAccessControl` /
  `UpdateOriginAccessControl` / `DeleteOriginAccessControl` /
  `CreateDistribution` / `GetDistribution` / `UpdateDistribution` /
  `DeleteDistribution` / `TagResource` / `UntagResource` /
  `ListTagsForResource` (Resource `*` — CloudFront doesn't support
  resource-level scoping for most of these pre-creation)
- `apigateway:GET` / `POST` / `PATCH` / `DELETE` / `PUT` on
  `arn:aws:apigateway:us-east-1::/domainnames`, `/domainnames/*`,
  `/apis/*/mappings`, `/apis/*/mappings/*`, `/tags/*`
- `iam:CreateServiceLinkedRole` for
  `arn:aws:iam::743281635965:role/aws-service-role/ops.apigateway.amazonaws.com/AWSServiceRoleForAPIGateway`
  (condition `iam:AWSServiceName = ops.apigateway.amazonaws.com`) — the
  service-linked role itself now exists in the account permanently; this
  statement can be dropped from future policy edits entirely.

**Resource-scoped — needs a new statement (or a wildcard) per new
environment:**
- S3 bucket actions (`CreateBucket`, `DeleteBucket`, `GetBucketLocation`,
  `Get/PutBucketPolicy`, `DeleteBucketPolicy`, `Get/PutBucketPublicAccessBlock`,
  `Get/PutBucketTagging`) were scoped to the literal
  `arn:aws:s3:::cinderblock-frontend-qa` — a prod bucket needs its own
  statement, or change the Resource to `arn:aws:s3:::cinderblock-frontend-*`
  once to cover every future env.
- `cloudfront:CreateInvalidation` / `GetInvalidation` / `ListInvalidations`
  was scoped to the qa distribution's ARN — same choice: new statement per
  distribution, or wildcard `arn:aws:cloudfront::743281635965:distribution/*`.

## Notes / gotchas

- ACM certs for CloudFront must be in **us-east-1** (this whole stack is us-east-1).
- Real Route 53 domain registration costs money and needs registrant contact info
  (collected at checkout, stored on the site record).
- Local state has no locking — avoid concurrent applies.
- `cinderblock.site`'s own DNS lives at Namecheap, not Route 53 — every
  custom-domain step above (ACM validation, the live `qa`/`api-qa` CNAMEs,
  and the SES checklist below) needs a manual Namecheap Advanced DNS edit;
  nothing in this repo can create those records itself.
