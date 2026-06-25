const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const formatExpiry = (expiresAt) =>
  new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));

const buildInviteEmailHtml = ({
  workspaceName,
  inviterName,
  inviteUrl,
  expiresAt,
}) => `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7f9;padding:24px;">
      <tr>
        <td align="center">
          <table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;background:#ffffff;border:1px solid #e2e8f0;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:24px 26px;border-bottom:1px solid #e2e8f0;">
                <div style="font-size:12px;line-height:18px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:.06em;">Narrative invitation</div>
                <div style="font-size:24px;line-height:30px;font-weight:800;margin-top:6px;color:#0f172a;">Join ${escapeHtml(workspaceName)}</div>
              </td>
            </tr>
            <tr>
              <td style="padding:26px;">
                <p style="font-size:15px;line-height:24px;margin:0;color:#334155;">
                  ${escapeHtml(inviterName)} invited you to join ${escapeHtml(workspaceName)} on Narrative.
                </p>
                <p style="font-size:15px;line-height:24px;margin:14px 0 0;color:#334155;">
                  Narrative helps agencies manage Meta ad reports and campaign signals.
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:22px;">
                  <tr>
                    <td>
                      <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;border-radius:10px;background:#0f172a;color:#ffffff;text-decoration:none;font-size:14px;line-height:20px;font-weight:700;padding:11px 16px;">
                        Accept invitation
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="font-size:13px;line-height:20px;margin:18px 0 0;color:#64748b;">
                  This invite expires on ${escapeHtml(formatExpiry(expiresAt))}.
                </p>
                <p style="font-size:13px;line-height:20px;margin:10px 0 0;color:#64748b;">
                  If you were not expecting this invitation, you can ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:15px 26px;border-top:1px solid #e2e8f0;background:#f8fafc;font-size:12px;line-height:18px;color:#64748b;">
                Narrative workspace access management
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

export const sendWorkspaceInviteEmail = async ({
  to,
  workspaceName,
  inviterName,
  inviteUrl,
  expiresAt,
}) => {
  const webhookUrl =
    process.env.WORKSPACE_INVITE_WEBHOOK_URL ||
    process.env.TEST_EMAIL_WEBHOOK_URL ||
    process.env.MOCK_REPORT_WEBHOOK_URL;

  if (!webhookUrl) {
    const err = new Error(
      "Workspace invite email delivery is not configured. Add WORKSPACE_INVITE_WEBHOOK_URL or reuse TEST_EMAIL_WEBHOOK_URL."
    );
    err.status = 501;
    throw err;
  }

  const emailSubject = "You've been invited to Narrative";
  const emailHtml = buildInviteEmailHtml({
    workspaceName,
    inviterName,
    inviteUrl,
    expiresAt,
  });
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: "workspace_invite",
      recipients: [to],
      email: to,
      emailSubject,
      subject: emailSubject,
      emailHtml,
      workspaceName,
      inviterName,
      inviteUrl,
      expiresAt,
      fromEmail: "reports@narrative.app",
    }),
  });

  if (!response.ok) {
    throw new Error(`Invite email webhook failed: ${response.status}`);
  }

  return { emailSubject, emailHtml };
};
