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

## Deploy (QA)

Prerequisite: **enable Bedrock model access** for the configured model in the AWS
console (Bedrock → Model access) once per account.

Optional prerequisite: to ground generated sites in real Google Business
Profile data (hours/phone/address/social links), create a Google Cloud
project with **Maps Grounding Lite** and **Places API (New)** enabled and
billing on, then set `google_maps_api_key` in `terraform.tfvars` (see
`qa/terraform.tfvars.example`). Without it, the site-builder just skips GBP
grounding.

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

## Notes / gotchas

- ACM certs for CloudFront must be in **us-east-1** (this whole stack is us-east-1).
- Real Route 53 domain registration costs money and needs registrant contact info
  (collected at checkout, stored on the site record).
- Local state has no locking — avoid concurrent applies.
