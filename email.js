const { Resend } = require('resend');

// Lazy-init so `require('./email')` doesn't crash in environments where
// RESEND_API_KEY is unset (e.g. local cron-script dry-runs). In production
// (Railway) the key is always set and getResend() returns a real client.
let _resend = null;
function getResend() {
  if (_resend) return _resend;
  if (!process.env.RESEND_API_KEY) return null;
  _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

async function sendPasswordResetEmail(toEmail, resetLink, displayName) {
  const fromAddress = process.env.EMAIL_FROM || 'hello@creativesgarden.com';
  const subject = "Reset your password — The Creative's Garden";
  const name = displayName || 'there';

  const text = `Hi ${name},

Someone requested a password reset for your account at The Creative's Garden.

If this was you, click the link below to set a new password. The link expires in 1 hour.

${resetLink}

If you didn't request this, you can safely ignore this email — your password won't change.

🌿
The Creative's Garden`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Reset your password</title></head>
<body style="font-family: Georgia, serif; background: #FAFAFA; margin: 0; padding: 32px;">
  <div style="max-width: 560px; margin: 0 auto; background: #F2EEE3; padding: 40px; border-radius: 8px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <img src="https://www.creativesgarden.com/images/brand/email-badge-green.png"
           alt="The Creative's Garden"
           width="96"
           height="96"
           style="display: inline-block; width: 96px; max-width: 96px; height: auto; border-radius: 50%;" />
    </div>
    <h1 style="font-family: Georgia, serif; color: #100F10; font-weight: 400; margin: 0 0 24px; font-size: 24px;">
      Reset your password
    </h1>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hi ${name},
    </p>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Someone requested a password reset for your account at The Creative's Garden.
    </p>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 24px;">
      If this was you, click the button below to set a new password. The link expires in 1 hour.
    </p>
    <p style="margin: 32px 0;">
      <a href="${resetLink}"
         style="background: #705C6C; color: #F2EEE3; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-family: Georgia, serif; display: inline-block;">
        Set a new password
      </a>
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 24px 0 0; font-style: italic;">
      If you didn't request this, you can safely ignore this email — your password won't change.
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 32px 0 0; text-align: center;">
      🌿 The Creative's Garden
    </p>
  </div>
</body>
</html>`;

  try {
    const client = getResend();
    if (!client) {
      console.warn('[email] RESEND_API_KEY not set — skipping send');
      return { ok: false, error: 'RESEND_API_KEY not set' };
    }
    const result = await client.emails.send({
      from: `The Creative's Garden <${fromAddress}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[email] Failed to send password reset:', err);
    return { ok: false, error: err.message };
  }
}

// ─── Admin milestone notifications ──────────────────────────────────────────
// Fires when a student crosses a meaningful checkpoint in the course (finishes
// onboarding, advances to naming seeds, etc.). The relevant content is attached
// as a PDF so Julia can read what the student wrote without logging in.
//
// The email body itself is intentionally calm — one line of context plus the
// brand sign-off — so the inbox doesn't feel demanding. Visual treatment mirrors
// the password-reset email above (pearl panel, Georgia, the brand bee badge).
async function sendAdminMilestoneEmail({ studentName, subject, bodyLine, pdf }) {
  const fromAddress = process.env.EMAIL_FROM || 'hello@creativesgarden.com';
  const adminEmail  = process.env.ADMIN_EMAIL || 'julia@meibostouch.com';
  const name        = studentName || 'A student';

  const text = `Hi Julia,

${bodyLine}

A PDF copy is attached.

🌿
The Creative's Garden`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Georgia, serif; background: #FAFAFA; margin: 0; padding: 32px;">
  <div style="max-width: 560px; margin: 0 auto; background: #F2EEE3; padding: 40px; border-radius: 8px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <img src="https://www.creativesgarden.com/images/brand/email-badge-green.png"
           alt="The Creative's Garden"
           width="96"
           height="96"
           style="display: inline-block; width: 96px; max-width: 96px; height: auto; border-radius: 50%;" />
    </div>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hi Julia,
    </p>
    <p style="color: #100F10; font-size: 16px; line-height: 1.7; margin: 0 0 20px;">
      ${bodyLine}
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 0 0 24px; font-style: italic;">
      A PDF copy is attached.
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 32px 0 0; text-align: center;">
      🌿 The Creative's Garden
    </p>
  </div>
</body>
</html>`;

  const payload = {
    from: `The Creative's Garden <${fromAddress}>`,
    to: adminEmail,
    subject,
    text,
    html,
  };

  if (pdf && pdf.buffer && pdf.filename) {
    payload.attachments = [{
      filename: pdf.filename,
      content: pdf.buffer.toString('base64'),
    }];
  }

  try {
    const client = getResend();
    if (!client) {
      console.warn('[email] RESEND_API_KEY not set — skipping send');
      return { ok: false, error: 'RESEND_API_KEY not set' };
    }
    const result = await client.emails.send(payload);
    console.log(`[email] Milestone "${subject}" sent for ${name}, id=${result.data?.id}`);
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error(`[email] Failed milestone "${subject}" for ${name}:`, err);
    return { ok: false, error: err.message };
  }
}

// ─── Daily reminder (student opt-in email channel) ──────────────────────────
// The email twin of the daily push. Sent by lib/daily-reminders.js to students
// who turned on "Email me the reminder." Calm, one gentle nudge + a link back
// to the dashboard, with a note on how to turn it off.
async function sendDailyReminderEmail(toEmail, displayName, nudge) {
  const fromAddress  = process.env.EMAIL_FROM || 'hello@creativesgarden.com';
  const appUrl       = (process.env.APP_URL || 'https://www.creativesgarden.com').replace(/\/$/, '');
  const dashboardUrl = `${appUrl}/dashboard`;
  const name         = displayName || 'there';
  const subject      = 'Your daily recording reminder 🌿';
  // The daily-reminder job rotates this line; fall back to a default if called
  // without one so the email still reads correctly.
  const line         = nudge || 'A gentle nudge — have you logged your recording for today?';

  const text = `Hi ${name},

${line}

Open your garden: ${dashboardUrl}

You can change the time or turn these reminders off anytime from your profile.

🌿
The Creative's Garden`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Georgia, serif; background: #FAFAFA; margin: 0; padding: 32px;">
  <div style="max-width: 560px; margin: 0 auto; background: #F2EEE3; padding: 40px; border-radius: 8px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <img src="https://www.creativesgarden.com/images/brand/email-badge-green.png"
           alt="The Creative's Garden"
           width="96"
           height="96"
           style="display: inline-block; width: 96px; max-width: 96px; height: auto; border-radius: 50%;" />
    </div>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hi ${name},
    </p>
    <p style="color: #100F10; font-size: 16px; line-height: 1.7; margin: 0 0 24px;">
      ${line}
    </p>
    <p style="margin: 32px 0;">
      <a href="${dashboardUrl}"
         style="background: #705C6C; color: #F2EEE3; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-family: Georgia, serif; display: inline-block;">
        Open your garden
      </a>
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 24px 0 0; font-style: italic;">
      You can change the time or turn these reminders off anytime from your profile.
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 32px 0 0; text-align: center;">
      🌿 The Creative's Garden
    </p>
  </div>
</body>
</html>`;

  try {
    const client = getResend();
    if (!client) {
      console.warn('[email] RESEND_API_KEY not set — skipping send');
      return { ok: false, error: 'RESEND_API_KEY not set' };
    }
    const result = await client.emails.send({
      from: `The Creative's Garden <${fromAddress}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[email] Failed to send daily reminder:', err);
    return { ok: false, error: err.message };
  }
}

// ─── Weekly reminder (Monday "set your intentions" nudge) ───────────────────
// Sent by lib/weekly-reminders.js to students who opted into the weekly email.
// Points at /weekly-intentions rather than the dashboard.
async function sendWeeklyReminderEmail(toEmail, displayName, nudge) {
  const fromAddress = process.env.EMAIL_FROM || 'hello@creativesgarden.com';
  const appUrl      = (process.env.APP_URL || 'https://www.creativesgarden.com').replace(/\/$/, '');
  const link        = `${appUrl}/weekly-intentions`;
  const name        = displayName || 'there';
  const subject     = 'A new week — set your intentions 🌱';
  const line        = nudge || 'It’s a new week. What would you like to tend to over the next few days?';

  const text = `Hi ${name},

${line}

Set your weekly intentions: ${link}

You can change the day/time or turn this off anytime from your profile.

🌿
The Creative's Garden`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${subject}</title></head>
<body style="font-family: Georgia, serif; background: #FAFAFA; margin: 0; padding: 32px;">
  <div style="max-width: 560px; margin: 0 auto; background: #F2EEE3; padding: 40px; border-radius: 8px;">
    <div style="text-align: center; margin-bottom: 32px;">
      <img src="https://www.creativesgarden.com/images/brand/email-badge-green.png"
           alt="The Creative's Garden"
           width="96"
           height="96"
           style="display: inline-block; width: 96px; max-width: 96px; height: auto; border-radius: 50%;" />
    </div>
    <p style="color: #100F10; font-size: 16px; line-height: 1.6; margin: 0 0 16px;">
      Hi ${name},
    </p>
    <p style="color: #100F10; font-size: 16px; line-height: 1.7; margin: 0 0 24px;">
      ${line}
    </p>
    <p style="margin: 32px 0;">
      <a href="${link}"
         style="background: #705C6C; color: #F2EEE3; text-decoration: none; padding: 14px 28px; border-radius: 6px; font-family: Georgia, serif; display: inline-block;">
        Set your intentions
      </a>
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 24px 0 0; font-style: italic;">
      You can change the day/time or turn this off anytime from your profile.
    </p>
    <p style="color: #76856C; font-size: 14px; line-height: 1.6; margin: 32px 0 0; text-align: center;">
      🌿 The Creative's Garden
    </p>
  </div>
</body>
</html>`;

  try {
    const client = getResend();
    if (!client) {
      console.warn('[email] RESEND_API_KEY not set — skipping send');
      return { ok: false, error: 'RESEND_API_KEY not set' };
    }
    const result = await client.emails.send({
      from: `The Creative's Garden <${fromAddress}>`,
      to: toEmail,
      subject,
      text,
      html,
    });
    return { ok: true, id: result.data?.id };
  } catch (err) {
    console.error('[email] Failed to send weekly reminder:', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendPasswordResetEmail, sendAdminMilestoneEmail, sendDailyReminderEmail, sendWeeklyReminderEmail };
