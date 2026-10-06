# Setup checklist

Claude Code cannot do these steps. Do them in order.

## Google

1. **Calendars.** Both calendars already exist and are called `High` and `Normal`, which are the defaults. If you rename them, set `CAL_HIGH` and `CAL_NORMAL` in step 4.
2. **Google's own notifications.** In Google Calendar: Settings → click each calendar under "Settings for my calendars" → Event notifications. Remove them to avoid a second ping, or keep one "at time of event" as an independent backup.
3. **Create the project.** Open https://script.google.com → New project. Rename it (e.g. "Nag").
   - Replace the contents of `Code.gs` with this repo's `Code.gs`.
   - Project Settings (gear icon) → tick "Show appsscript.json manifest file in editor". Then open `appsscript.json` in the editor and replace it with this repo's file.
4. **Script properties.** Project Settings → Script Properties → Add script property:
   - `NTFY_TOPIC`: random, at least 24 characters. This is effectively a password.
   - `SECRET`: random, at least 24 characters.
   - `ALERT_EMAIL`: your email address.
   - `CAL_HIGH` and `CAL_NORMAL`: only needed if the calendar names differ from `High` and `Normal`.
5. **Deploy as web app.** Deploy → New deployment → gear icon → Web app. Execute as: **Me**. Who has access: **Anyone**. Deploy and approve the permission prompt. Copy the `/exec` URL and add it as script property `WEBAPP_URL`.
   - Later code changes only reach the URL after Deploy → Manage deployments → pencil on the existing deployment → Version: **New version** → Deploy. Never create a new deployment: it changes the URL and breaks every button already sent.
6. **Run `setup()` once.** Select `setup` in the function dropdown → Run → approve the permission prompt. Google asks for access to all calendars; the script only reads the two named ones. Check the execution log: both calendars should say "found".
7. **Failure emails.** Left sidebar → Triggers → the `tick` trigger → Failure notification settings → **Notify me immediately**.
8. **Dry run.** Run `dryRun()`. The log should list the events in both calendars with the right due times and profiles, and nothing else.
9. **Test nag.** Run `sendTestNag()`, then press each button on the phone (Done, +30 min, +2 h).

## Phone (Pixel)

1. Install **ntfy** from Google Play. Subscribe to your `NTFY_TOPIC` on the default server (ntfy.sh) and tick **Instant delivery in doze mode**.
2. Settings → Apps → ntfy → Battery → **Unrestricted**.
3. In ntfy's notification channel settings, give the **Max** and **High** priority channels distinct, loud sounds.
4. Do Not Disturb: if the Pixel has a night schedule, a reminder deliberately set at night stays silent unless the ntfy channels may override Do Not Disturb. Allowing that also lets daytime reminders through during meetings. Your choice.

## Then run the manual acceptance tests

See section 15 of the spec (tests 3–16). Tests 4–16 need the phone. If a test shows that replacing a notification stays silent (test 8), see `sequence_id` in `buildPayload_` in `Code.gs`: remove that line to fall back to separate notifications.

## Tuning

Constants are at the top of `Code.gs` (`PROFILES`, `QUIET_START`, `QUIET_END`, `EMAIL_AFTER_MIN`, `DAILY_SOFT_LIMIT`, `LOOKBACK_DAYS`). Edit, then deploy a new version (step 5).
