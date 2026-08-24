/**
 * cognito-email-sender Lambda — Cognito Custom Email Sender trigger.
 *
 * Cognito invokes this synchronously for CustomEmailSender_SignUp,
 * CustomEmailSender_ResendCode, and CustomEmailSender_ForgotPassword (the
 * verification paths this pool exercises today) instead of using its own
 * default mailer. It hands the 6-digit code over encrypted, never plaintext
 * — this Lambda decrypts it and is fully responsible for delivering the
 * email itself via SES. Cognito does not expect (or accept) the code back in
 * the response; a non-throwing return is the only signal it needs.
 *
 * IMPORTANT: Cognito does NOT encrypt this code with a plain KMS
 * Encrypt/Decrypt call — it uses the AWS Encryption SDK (an envelope format
 * wrapping algorithm info + an encrypted data key + the payload + integrity
 * checks). A raw `KMSClient`/`DecryptCommand` call cannot parse that format
 * and fails with InvalidCiphertextException regardless of encryption
 * context — this is the AWS-documented approach:
 * https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-custom-email-sender.html
 *
 * template.html and reset-password-template.html are static, pre-rendered
 * copies of the backend's SignupVerificationEmail.tsx and
 * ResetPasswordEmail.tsx (cinderblock-backend/src/emails), regenerated and
 * copied here by hand whenever either template changes — this Lambda can't
 * import a .tsx React component from a different repo/build system. See
 * each template's header comment for the sync step.
 *
 * Unlike the other infra Lambdas, this one has a real npm dependency
 * (@aws-crypto/client-node) and ships node_modules in its zip — see
 * build-lambda.sh, which runs `npm install` here before packaging.
 */
import { KmsKeyringNode, buildClient, CommitmentPolicy } from "@aws-crypto/client-node";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SES_FROM_ADDRESS = process.env.SES_FROM_ADDRESS;
const SES_CONFIGURATION_SET = process.env.SES_CONFIGURATION_SET;

const HANDLED_TRIGGERS = new Set([
  "CustomEmailSender_SignUp",
  "CustomEmailSender_ResendCode",
  "CustomEmailSender_ForgotPassword",
]);

const { decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_ALLOW_DECRYPT);
const keyring = new KmsKeyringNode({
  generatorKeyId: process.env.KMS_KEY_ID,
  keyIds: [process.env.KMS_KEY_ARN],
});

const ses = new SESv2Client({ region: "us-east-1" }); // SES identity lives in us-east-1

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TEMPLATES = {
  CustomEmailSender_SignUp: {
    html: readFileSync(path.join(__dirname, "template.html"), "utf-8"),
    subject: "Verify your Cinderblock account",
    text: (code) => `Your Cinderblock verification code is ${code}. This code expires in 1 hour.`,
  },
  CustomEmailSender_ResendCode: {
    html: readFileSync(path.join(__dirname, "template.html"), "utf-8"),
    subject: "Verify your Cinderblock account",
    text: (code) => `Your Cinderblock verification code is ${code}. This code expires in 1 hour.`,
  },
  CustomEmailSender_ForgotPassword: {
    html: readFileSync(path.join(__dirname, "reset-password-template.html"), "utf-8"),
    subject: "Reset your Cinderblock password",
    text: (code) => `Your Cinderblock password reset code is ${code}. This code expires in 1 hour.`,
  },
};

function renderHtml(template, code) {
  return template.html.replaceAll("{{CODE}}", code);
}

async function decryptCode(event) {
  const { plaintext } = await decrypt(keyring, Buffer.from(event.request.code, "base64"));
  return Buffer.from(plaintext).toString("utf-8");
}

export const handler = async (event) => {
  if (!HANDLED_TRIGGERS.has(event.triggerSource)) {
    // Unhandled trigger source (e.g. account recovery, admin-create) — return
    // unmodified per the Custom Email Sender contract rather than throwing.
    return event;
  }

  const email = event.request?.userAttributes?.email;
  if (!email) {
    throw new Error(`No email attribute on user ${event.userName}`);
  }

  const code = await decryptCode(event);
  const template = TEMPLATES[event.triggerSource];

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: SES_FROM_ADDRESS,
      Destination: { ToAddresses: [email] },
      ConfigurationSetName: SES_CONFIGURATION_SET,
      Content: {
        Simple: {
          Subject: { Data: template.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: renderHtml(template, code), Charset: "UTF-8" },
            Text: { Data: template.text(code), Charset: "UTF-8" },
          },
        },
      },
    })
  );

  return event;
};
