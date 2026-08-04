# ---------------------------------------------------------------------------
# site-builder Lambda — Bedrock designs a complete self-contained HTML site
# (guardrail-protected against prompt injection) -> preview bucket.
# ---------------------------------------------------------------------------
resource "aws_bedrock_guardrail" "site_builder" {
  name = "cinderblock-site-builder-guardrail-${local.env}"
  # Set explicitly (not left computed): some AWS provider versions hit a
  # "Provider returned invalid result object after apply" consistency error
  # on this field immediately after guardrail creation when it's left unset.
  description               = "Screens the Cinderblock site-builder's Bedrock calls for prompt injection and content-policy issues."
  blocked_input_messaging   = "This request was blocked by our safety checks."
  blocked_outputs_messaging = "The generated content was blocked by our safety checks."

  content_policy_config {
    filters_config {
      type            = "PROMPT_ATTACK"
      input_strength  = "HIGH"
      output_strength = "NONE" # AWS constraint: PROMPT_ATTACK only supports the INPUT tier
    }
    filters_config {
      type            = "HATE"
      input_strength  = "HIGH"
      output_strength = "HIGH"
    }
    filters_config {
      # MEDIUM, not HIGH: Cinderblock serves arbitrary small businesses, and
      # HIGH-strength SEXUAL/VIOLENCE/MISCONDUCT filters risk false-positive
      # blocking entirely legitimate, legal verticals (firearms/self-defense
      # training, adult retail, cannabis dispensaries in legal states,
      # combat-sports gyms). MEDIUM still meaningfully protects against
      # actually bad content with less false-positive risk; tune from
      # observed QA behavior.
      type            = "INSULTS"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "SEXUAL"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "VIOLENCE"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
    filters_config {
      type            = "MISCONDUCT"
      input_strength  = "MEDIUM"
      output_strength = "MEDIUM"
    }
  }

  # No custom topic_policy_config: a hand-written "OverrideOrRevealInstructions"
  # DENY topic was tried here and confirmed (via a live CloudWatch trace, not
  # guesswork) to false-positive-block entirely benign business descriptions
  # that merely mention AI/prompts/instructions — exactly the kind of customer
  # Cinderblock itself is likely to attract. Bedrock's semantic topic
  # classifier matches on meaning, not literal keywords, so "an AI company
  # that generates output from input" sits too close to "manipulates an AI's
  # instructions" for a hand-rolled definition to distinguish reliably.
  # PROMPT_ATTACK above is Amazon's purpose-built, better-calibrated
  # classifier for the same threat — it correctly did NOT fire on the same
  # content — so it's the sole prompt-injection defense here rather than
  # layering in a redundant, worse-tuned custom topic.

  tags = {
    Name = "cinderblock-site-builder-guardrail-${local.env}"
  }
}

# Deliberately no aws_bedrock_guardrail_version / pinned version number here.
# Published Bedrock guardrail versions are immutable snapshots — editing this
# resource only ever changes DRAFT, and a version resource whose only input is
# a stable ARN gives Terraform no signal to ever publish a new version, so a
# Lambda pinned to a numbered version silently keeps running a stale policy
# forever after any edit (hit this for real: a guardrail config change here
# didn't take effect because the Lambda was still on a frozen version 1).
# Pointing at "DRAFT" directly means every apply takes effect immediately —
# appropriate for qa; reconsider (pinned version + explicit republish step)
# for a prod env that wants an audit trail.

resource "aws_iam_role" "site_builder" {
  name               = "cinderblock-site-builder-role-${local.env}"
  assume_role_policy = local.lambda_assume_role
}

resource "aws_iam_role_policy" "site_builder" {
  name = "cinderblock-site-builder-policy-${local.env}"
  role = aws_iam_role.site_builder.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = ["arn:aws:logs:${local.region}:${local.account_id}:log-group:/aws/lambda/cinderblock-site-builder-${local.env}:*"]
      },
      {
        Effect   = "Allow"
        Action   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
        Resource = [var.sites_table_arn]
      },
      {
        Effect = "Allow"
        Action = ["bedrock:InvokeModel"]
        Resource = [
          "arn:aws:bedrock:${local.region}::foundation-model/${var.bedrock_model_id}",
          "arn:aws:bedrock:*::foundation-model/*",
          "arn:aws:bedrock:${local.region}:${local.account_id}:inference-profile/*"
        ]
      },
      {
        Sid      = "ApplyGuardrail"
        Effect   = "Allow"
        Action   = ["bedrock:ApplyGuardrail"]
        Resource = [aws_bedrock_guardrail.site_builder.guardrail_arn]
      },
      {
        # Read user uploads.
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = ["${var.uploads_bucket_arn}/*"]
      },
      {
        # Create, write, and read back per-site public preview + sandbox
        # buckets. GetObject is needed both for HeadObject calls (S3 checks
        # the GetObject IAM action for HEAD requests) when skipping
        # already-copied images, and for reading the prior index.html back on
        # a revision (falling back to the live preview bucket on the first
        # sandbox revision of an already-live site).
        Effect = "Allow"
        Action = [
          "s3:CreateBucket",
          "s3:PutObject",
          "s3:GetObject",
          "s3:PutBucketPolicy",
          "s3:PutBucketWebsite",
          "s3:PutBucketPublicAccessBlock",
          "s3:GetBucketPolicy",
          "s3:ListBucket"
        ]
        Resource = concat(local.preview_bucket_arns, local.sandbox_bucket_arns)
      }
    ]
  })
}

resource "aws_lambda_function" "site_builder" {
  function_name    = "cinderblock-site-builder-${local.env}"
  filename         = var.lambda_site_builder_zip_path
  source_code_hash = filebase64sha256(var.lambda_site_builder_zip_path)
  role             = aws_iam_role.site_builder.arn
  handler          = "index.handler"
  runtime          = "nodejs22.x"
  # Bumped again for the Astro+Tailwind rewrite: on top of Bedrock generation
  # and two external context fetches, every invocation now also runs a real
  # `npm install && npm run build` in /tmp (no dependency-install caching
  # across invocations), which alone can take a few minutes.
  timeout     = 900
  memory_size = 2048

  ephemeral_storage {
    size = 2048 # node_modules + npm cache + the built dist/ output
  }

  environment {
    variables = {
      ENV                       = local.env
      SITES_TABLE               = var.sites_table_name
      UPLOADS_BUCKET            = var.uploads_bucket_name
      BEDROCK_MODEL_ID          = var.bedrock_model_id
      BEDROCK_GUARDRAIL_ID      = aws_bedrock_guardrail.site_builder.guardrail_id
      BEDROCK_GUARDRAIL_VERSION = "DRAFT"
      # Third-party HTTPS call (Maps Grounding Lite MCP + Places API (New)) —
      # no AWS IAM permission needed, just open internet egress (already
      # available, this Lambda isn't VPC-attached).
      GOOGLE_MAPS_API_KEY = var.google_maps_api_key
    }
  }
}
