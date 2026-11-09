// Credential catalogue, modelled on n8n's credential types: each service declares which auth styles it
// supports and the fields each needs. OAuth2 entries carry the provider's authorize/token URLs, default
// scopes, how the client authenticates at the token endpoint ("header" = HTTP basic, "body" = form fields),
// extra authorize query parameters, and whether PKCE is used. Everything a user pastes is stored encrypted
// by vault.js and exported to shells as <PREFIX>_<FIELD> environment variables.

// ---------- auth styles ----------
// Field: { name, label, secret, env, placeholder, optional }
export const AUTH_STYLES = {
    apiKey:  { title: 'API key',           fields: [{ name: 'apiKey', label: 'API key', secret: true, env: 'API_KEY' }] },
    token:   { title: 'Access token',      fields: [{ name: 'token', label: 'Token', secret: true, env: 'TOKEN' }] },
    basic:   { title: 'Username + password', fields: [{ name: 'username', label: 'Username', env: 'USER' }, { name: 'password', label: 'Password', secret: true, env: 'PASSWORD' }] },
    header:  { title: 'Custom header',     fields: [{ name: 'headerName', label: 'Header name', env: 'HEADER_NAME', placeholder: 'X-Api-Key' }, { name: 'headerValue', label: 'Header value', secret: true, env: 'HEADER_VALUE' }] },
    awsKeys: { title: 'Access key + secret', fields: [{ name: 'accessKeyId', label: 'Access key ID', env: 'ACCESS_KEY_ID' }, { name: 'secretAccessKey', label: 'Secret access key', secret: true, env: 'SECRET_ACCESS_KEY' }, { name: 'region', label: 'Region', env: 'DEFAULT_REGION', placeholder: 'eu-west-2', optional: true }] },
    s3Bucket: { title: 'S3 bucket + keys', fields: [{ name: 'accessKeyId', label: 'Access key ID', env: 'ACCESS_KEY_ID' }, { name: 'secretAccessKey', label: 'Secret access key', secret: true, env: 'SECRET_ACCESS_KEY' }, { name: 'bucket', label: 'Bucket', env: 'BUCKET' }, { name: 'region', label: 'Region', env: 'REGION', placeholder: 'eu-west-2' }, { name: 'prefix', label: 'Folder in the bucket', env: 'PREFIX', optional: true }, { name: 'endpoint', label: 'Endpoint (only for S3-compatible storage)', env: 'ENDPOINT', optional: true }] },
    urlToken: { title: 'URL + token',      fields: [{ name: 'url', label: 'Base URL', env: 'URL', placeholder: 'https://…' }, { name: 'token', label: 'Token', secret: true, env: 'TOKEN' }] },
    sidToken: { title: 'Account SID + auth token', fields: [{ name: 'accountSid', label: 'Account SID', env: 'ACCOUNT_SID' }, { name: 'authToken', label: 'Auth token', secret: true, env: 'AUTH_TOKEN' }] },
    keyToken: { title: 'API key + token',  fields: [{ name: 'apiKey', label: 'API key', env: 'API_KEY' }, { name: 'token', label: 'Token', secret: true, env: 'TOKEN' }] },
    clientPair: { title: 'Client ID + secret', fields: [{ name: 'clientId', label: 'Client ID', env: 'CLIENT_ID' }, { name: 'clientSecret', label: 'Client secret', secret: true, env: 'CLIENT_SECRET' }] },
    json:    { title: 'JSON credentials file', fields: [{ name: 'json', label: 'JSON', secret: true, env: 'CREDENTIALS_JSON', multiline: true }] },
    webhook: { title: 'Webhook URL',        fields: [{ name: 'url', label: 'Webhook URL', secret: true, env: 'WEBHOOK_URL', placeholder: 'https://…' }] },
    botChat: { title: 'Bot token + chat',   fields: [{ name: 'botToken', label: 'Bot token', secret: true, env: 'BOT_TOKEN' }, { name: 'chatId', label: 'Default chat ID', env: 'CHAT_ID', optional: true }] },
    smtp:    { title: 'SMTP server',        fields: [{ name: 'host', label: 'Host', env: 'HOST', placeholder: 'smtp.example.com' }, { name: 'port', label: 'Port', env: 'PORT', placeholder: '587' }, { name: 'user', label: 'Username', env: 'USER' }, { name: 'password', label: 'Password', secret: true, env: 'PASSWORD' }, { name: 'from', label: 'From address', env: 'FROM', optional: true }] },
    dbUrl:   { title: 'Connection URL',     fields: [{ name: 'url', label: 'Connection URL', secret: true, env: 'URL', placeholder: 'postgres://user:pass@host:5432/db' }] },
    urlTopic: { title: 'Server URL + topic', fields: [{ name: 'url', label: 'Server URL', env: 'URL', placeholder: 'https://ntfy.sh' }, { name: 'topic', label: 'Topic', env: 'TOPIC' }, { name: 'token', label: 'Access token', secret: true, env: 'TOKEN', optional: true }] },
    sshKey:  { title: 'SSH private key',    fields: [{ name: 'host', label: 'Host', env: 'HOST' }, { name: 'user', label: 'User', env: 'USER' }, { name: 'privateKey', label: 'Private key (PEM)', secret: true, env: 'PRIVATE_KEY', multiline: true }] },
    // OAuth2 (authorization code). Client fields are entered; tokens are obtained by the Connect flow.
    oauth2:  { title: 'OAuth2 (connect account)', fields: [
        { name: 'clientId', label: 'Client ID', env: 'CLIENT_ID' },
        { name: 'clientSecret', label: 'Client secret', secret: true, env: 'CLIENT_SECRET', optional: true },
        { name: 'scopes', label: 'Scopes', env: 'SCOPES', optional: true },
        { name: 'accessToken', label: 'Access token', secret: true, env: 'ACCESS_TOKEN', derived: true },
        { name: 'refreshToken', label: 'Refresh token', secret: true, env: 'REFRESH_TOKEN', derived: true },
    ] },
};

// Generic OAuth2 fields a custom service can override (same vocabulary as n8n's generic OAuth2 credential).
export const OAUTH2_GENERIC = { authUrl: '', tokenUrl: '', scopes: '', clientAuth: 'body', authParams: {}, pkce: false, scopeSeparator: ' ' };

const g = (authUrl, tokenUrl, scopes, extra = {}) => ({ authUrl, tokenUrl, scopes, clientAuth: 'body', scopeSeparator: ' ', ...extra });
const GOOGLE = (scopes) => g('https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token', scopes, { authParams: { access_type: 'offline', prompt: 'consent' } });
const MS = (scopes) => g('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', 'https://login.microsoftonline.com/common/oauth2/v2.0/token', scopes);

// ---------- services ----------
// { key, title, category, env, docs, auth: { style: oauth2preset|true }, note }
export const services = [
    // AI
    { key: 'openai', title: 'OpenAI', category: 'AI', env: 'OPENAI', docs: 'https://platform.openai.com/api-keys', auth: { apiKey: true } },
    { key: 'anthropic', title: 'Anthropic', category: 'AI', env: 'ANTHROPIC', docs: 'https://console.anthropic.com/settings/keys', auth: { apiKey: true } },
    { key: 'google-ai', title: 'Google AI (Gemini)', category: 'AI', env: 'GEMINI', docs: 'https://aistudio.google.com/apikey', auth: { apiKey: true } },
    { key: 'huggingface', title: 'Hugging Face', category: 'AI', env: 'HF', docs: 'https://huggingface.co/settings/tokens', auth: { token: true } },
    { key: 'replicate', title: 'Replicate', category: 'AI', env: 'REPLICATE', docs: 'https://replicate.com/account/api-tokens', auth: { token: true } },
    { key: 'elevenlabs', title: 'ElevenLabs', category: 'AI', env: 'ELEVENLABS', docs: 'https://elevenlabs.io/app/settings/api-keys', auth: { apiKey: true } },
    { key: 'deepl', title: 'DeepL', category: 'AI', env: 'DEEPL', docs: 'https://www.deepl.com/your-account/keys', auth: { apiKey: true } },
    { key: 'mistral', title: 'Mistral', category: 'AI', env: 'MISTRAL', docs: 'https://console.mistral.ai/api-keys', auth: { apiKey: true } },
    { key: 'groq', title: 'Groq', category: 'AI', env: 'GROQ', docs: 'https://console.groq.com/keys', auth: { apiKey: true } },
    { key: 'openrouter', title: 'OpenRouter', category: 'AI', env: 'OPENROUTER', docs: 'https://openrouter.ai/keys', auth: { apiKey: true } },

    // Developer platforms
    { key: 'github', title: 'GitHub', category: 'Developer', env: 'GH', docs: 'https://github.com/settings/tokens', auth: { token: true, oauth2: g('https://github.com/login/oauth/authorize', 'https://github.com/login/oauth/access_token', 'repo read:org workflow') }, note: 'A fine-grained token as GH_TOKEN is what gh and git on the box use.' },
    { key: 'gitlab', title: 'GitLab', category: 'Developer', env: 'GITLAB', docs: 'https://gitlab.com/-/user_settings/personal_access_tokens', auth: { token: true, oauth2: g('https://gitlab.com/oauth/authorize', 'https://gitlab.com/oauth/token', 'api read_user', { pkce: true }) } },
    { key: 'bitbucket', title: 'Bitbucket', category: 'Developer', env: 'BITBUCKET', docs: 'https://bitbucket.org/account/settings/app-passwords/', auth: { basic: true, oauth2: g('https://bitbucket.org/site/oauth2/authorize', 'https://bitbucket.org/site/oauth2/access_token', 'repository account', { clientAuth: 'header' }) } },
    { key: 'vercel', title: 'Vercel', category: 'Developer', env: 'VERCEL', docs: 'https://vercel.com/account/tokens', auth: { token: true } },
    { key: 'netlify', title: 'Netlify', category: 'Developer', env: 'NETLIFY', docs: 'https://app.netlify.com/user/applications', auth: { token: true } },
    { key: 'cloudflare', title: 'Cloudflare', category: 'Developer', env: 'CLOUDFLARE', docs: 'https://dash.cloudflare.com/profile/api-tokens', auth: { token: true }, note: 'Also set CLOUDFLARE_ACCOUNT_ID as a custom field if tools need it.' },
    { key: 'digitalocean', title: 'DigitalOcean', category: 'Developer', env: 'DIGITALOCEAN', docs: 'https://cloud.digitalocean.com/account/api/tokens', auth: { token: true } },
    { key: 'hetzner', title: 'Hetzner Cloud', category: 'Developer', env: 'HCLOUD', docs: 'https://console.hetzner.cloud/', auth: { token: true } },
    { key: 'backup-storage', title: 'Backup storage (S3)', category: 'Developer', env: 'BACKUP', docs: 'https://console.aws.amazon.com/iam/home#/users', auth: { s3Bucket: true }, note: 'Where PlatOpypus puts project backups. A key that can only read, write and list this one bucket is enough; PlatOpypus never hands it to agents.' },
    { key: 'aws', title: 'AWS', category: 'Developer', env: 'AWS', docs: 'https://console.aws.amazon.com/iam/home#/security_credentials', auth: { awsKeys: true }, note: 'The box already has an instance role; add keys only for a different account.' },
    { key: 'docker-hub', title: 'Docker Hub', category: 'Developer', env: 'DOCKERHUB', docs: 'https://hub.docker.com/settings/security', auth: { basic: true } },
    { key: 'npm', title: 'npm', category: 'Developer', env: 'NPM', docs: 'https://www.npmjs.com/settings/~/tokens', auth: { token: true } },
    { key: 'sentry', title: 'Sentry', category: 'Developer', env: 'SENTRY', docs: 'https://sentry.io/settings/account/api/auth-tokens/', auth: { token: true } },
    { key: 'tailscale', title: 'Tailscale', category: 'Developer', env: 'TAILSCALE', docs: 'https://login.tailscale.com/admin/settings/keys', auth: { apiKey: true } },
    { key: 'supabase', title: 'Supabase', category: 'Developer', env: 'SUPABASE', docs: 'https://supabase.com/dashboard/project/_/settings/api', auth: { urlToken: true }, note: 'Use the service-role key as the token for server-side work.' },
    { key: 'firebase', title: 'Firebase / Google Cloud service account', category: 'Developer', env: 'GOOGLE', docs: 'https://console.cloud.google.com/iam-admin/serviceaccounts', auth: { json: true }, note: 'Exports GOOGLE_CREDENTIALS_JSON; write it to a file for GOOGLE_APPLICATION_CREDENTIALS.' },
    { key: 'stripe', title: 'Stripe', category: 'Payments', env: 'STRIPE', docs: 'https://dashboard.stripe.com/apikeys', auth: { apiKey: true } },
    { key: 'paypal', title: 'PayPal', category: 'Payments', env: 'PAYPAL', docs: 'https://developer.paypal.com/dashboard/applications', auth: { clientPair: true } },
    { key: 'shopify', title: 'Shopify', category: 'Payments', env: 'SHOPIFY', docs: 'https://shopify.dev/docs/apps/auth/admin-app-access-tokens', auth: { urlToken: true } },

    // Google
    { key: 'google-drive', title: 'Google Drive', category: 'Google', env: 'GOOGLE_DRIVE', docs: 'https://console.cloud.google.com/apis/credentials', auth: { oauth2: GOOGLE('https://www.googleapis.com/auth/drive') } },
    { key: 'google-sheets', title: 'Google Sheets', category: 'Google', env: 'GOOGLE_SHEETS', docs: 'https://console.cloud.google.com/apis/credentials', auth: { oauth2: GOOGLE('https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file') } },
    { key: 'gmail', title: 'Gmail', category: 'Google', env: 'GMAIL', docs: 'https://console.cloud.google.com/apis/credentials', auth: { oauth2: GOOGLE('https://www.googleapis.com/auth/gmail.modify') } },
    { key: 'google-calendar', title: 'Google Calendar', category: 'Google', env: 'GOOGLE_CALENDAR', docs: 'https://console.cloud.google.com/apis/credentials', auth: { oauth2: GOOGLE('https://www.googleapis.com/auth/calendar') } },
    { key: 'youtube', title: 'YouTube', category: 'Google', env: 'YOUTUBE', docs: 'https://console.cloud.google.com/apis/credentials', auth: { oauth2: GOOGLE('https://www.googleapis.com/auth/youtube'), apiKey: true } },
    { key: 'google-maps', title: 'Google Maps', category: 'Google', env: 'GOOGLE_MAPS', docs: 'https://console.cloud.google.com/apis/credentials', auth: { apiKey: true } },

    // Microsoft
    { key: 'microsoft', title: 'Microsoft 365 (Graph)', category: 'Microsoft', env: 'MS_GRAPH', docs: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps', auth: { oauth2: MS('offline_access User.Read Files.ReadWrite Mail.ReadWrite Calendars.ReadWrite') } },
    { key: 'onedrive', title: 'OneDrive', category: 'Microsoft', env: 'ONEDRIVE', docs: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps', auth: { oauth2: MS('offline_access Files.ReadWrite.All') } },

    // Communication
    { key: 'slack', title: 'Slack', category: 'Communication', env: 'SLACK', docs: 'https://api.slack.com/apps', auth: { token: true, oauth2: g('https://slack.com/oauth/v2/authorize', 'https://slack.com/api/oauth.v2.access', 'chat:write channels:read users:read', { scopeSeparator: ',' }) }, note: 'Bot tokens (xoxb-) go in as a token; OAuth2 for user-scoped access.' },
    { key: 'discord', title: 'Discord', category: 'Communication', env: 'DISCORD', docs: 'https://discord.com/developers/applications', auth: { token: true, oauth2: g('https://discord.com/api/oauth2/authorize', 'https://discord.com/api/oauth2/token', 'identify guilds') }, note: 'Bot token as token; OAuth2 for acting as a user.' },
    { key: 'telegram', title: 'Telegram Bot', category: 'Communication', env: 'TELEGRAM', docs: 'https://core.telegram.org/bots#botfather', auth: { token: true } },
    { key: 'twilio', title: 'Twilio', category: 'Communication', env: 'TWILIO', docs: 'https://console.twilio.com/', auth: { sidToken: true } },
    { key: 'sendgrid', title: 'SendGrid', category: 'Communication', env: 'SENDGRID', docs: 'https://app.sendgrid.com/settings/api_keys', auth: { apiKey: true } },
    { key: 'mailgun', title: 'Mailgun', category: 'Communication', env: 'MAILGUN', docs: 'https://app.mailgun.com/settings/api_security', auth: { apiKey: true } },
    { key: 'postmark', title: 'Postmark', category: 'Communication', env: 'POSTMARK', docs: 'https://account.postmarkapp.com/servers', auth: { token: true } },
    { key: 'resend', title: 'Resend', category: 'Communication', env: 'RESEND', docs: 'https://resend.com/api-keys', auth: { apiKey: true } },
    { key: 'pushover', title: 'Pushover', category: 'Communication', env: 'PUSHOVER', docs: 'https://pushover.net/apps', auth: { keyToken: true } },

    // Productivity
    { key: 'notion', title: 'Notion', category: 'Productivity', env: 'NOTION', docs: 'https://www.notion.so/my-integrations', auth: { token: true, oauth2: g('https://api.notion.com/v1/oauth/authorize', 'https://api.notion.com/v1/oauth/token', '', { clientAuth: 'header', authParams: { owner: 'user' } }) } },
    { key: 'airtable', title: 'Airtable', category: 'Productivity', env: 'AIRTABLE', docs: 'https://airtable.com/create/tokens', auth: { token: true, oauth2: g('https://airtable.com/oauth2/v1/authorize', 'https://airtable.com/oauth2/v1/token', 'data.records:read data.records:write schema.bases:read', { pkce: true, clientAuth: 'header' }) } },
    { key: 'todoist', title: 'Todoist', category: 'Productivity', env: 'TODOIST', docs: 'https://app.todoist.com/app/settings/integrations/developer', auth: { token: true, oauth2: g('https://todoist.com/oauth/authorize', 'https://todoist.com/oauth/access_token', 'data:read_write', { scopeSeparator: ',' }) } },
    { key: 'asana', title: 'Asana', category: 'Productivity', env: 'ASANA', docs: 'https://app.asana.com/0/my-apps', auth: { token: true, oauth2: g('https://app.asana.com/-/oauth_authorize', 'https://app.asana.com/-/oauth_token', 'default') } },
    { key: 'trello', title: 'Trello', category: 'Productivity', env: 'TRELLO', docs: 'https://trello.com/power-ups/admin', auth: { keyToken: true } },
    { key: 'linear', title: 'Linear', category: 'Productivity', env: 'LINEAR', docs: 'https://linear.app/settings/api', auth: { apiKey: true, oauth2: g('https://linear.app/oauth/authorize', 'https://api.linear.app/oauth/token', 'read write', { scopeSeparator: ',' }) } },
    { key: 'jira', title: 'Jira Cloud', category: 'Productivity', env: 'JIRA', docs: 'https://developer.atlassian.com/console/myapps/', auth: { basic: true, oauth2: g('https://auth.atlassian.com/authorize', 'https://auth.atlassian.com/oauth/token', 'read:jira-work write:jira-work offline_access', { authParams: { audience: 'api.atlassian.com', prompt: 'consent' } }) }, note: 'Basic = e-mail + API token.' },
    { key: 'clickup', title: 'ClickUp', category: 'Productivity', env: 'CLICKUP', docs: 'https://app.clickup.com/settings/apps', auth: { token: true, oauth2: g('https://app.clickup.com/api', 'https://api.clickup.com/api/v2/oauth/token', '') } },
    { key: 'hubspot', title: 'HubSpot', category: 'Productivity', env: 'HUBSPOT', docs: 'https://developers.hubspot.com/', auth: { token: true, oauth2: g('https://app.hubspot.com/oauth/authorize', 'https://api.hubapi.com/oauth/v1/token', 'crm.objects.contacts.read crm.objects.contacts.write') } },

    // Media & personal
    { key: 'spotify', title: 'Spotify', category: 'Media', env: 'SPOTIFY', docs: 'https://developer.spotify.com/dashboard', auth: { oauth2: g('https://accounts.spotify.com/authorize', 'https://accounts.spotify.com/api/token', 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-modify-private playlist-modify-public user-library-read user-library-modify', { clientAuth: 'header' }) } },
    { key: 'reddit', title: 'Reddit', category: 'Media', env: 'REDDIT', docs: 'https://www.reddit.com/prefs/apps', auth: { oauth2: g('https://www.reddit.com/api/v1/authorize', 'https://www.reddit.com/api/v1/access_token', 'identity read submit history', { clientAuth: 'header', authParams: { duration: 'permanent' } }) } },
    { key: 'twitter', title: 'X (Twitter)', category: 'Media', env: 'X', docs: 'https://developer.x.com/en/portal/dashboard', auth: { oauth2: g('https://twitter.com/i/oauth2/authorize', 'https://api.twitter.com/2/oauth2/token', 'tweet.read tweet.write users.read offline.access', { pkce: true, clientAuth: 'header' }) } },
    { key: 'strava', title: 'Strava', category: 'Media', env: 'STRAVA', docs: 'https://www.strava.com/settings/api', auth: { oauth2: g('https://www.strava.com/oauth/authorize', 'https://www.strava.com/oauth/token', 'read,activity:read_all', { scopeSeparator: ',' }) } },
    { key: 'fitbit', title: 'Fitbit', category: 'Media', env: 'FITBIT', docs: 'https://dev.fitbit.com/apps', auth: { oauth2: g('https://www.fitbit.com/oauth2/authorize', 'https://api.fitbit.com/oauth2/token', 'activity heartrate sleep profile', { pkce: true, clientAuth: 'header' }) } },
    { key: 'dropbox', title: 'Dropbox', category: 'Media', env: 'DROPBOX', docs: 'https://www.dropbox.com/developers/apps', auth: { oauth2: g('https://www.dropbox.com/oauth2/authorize', 'https://api.dropboxapi.com/oauth2/token', '', { authParams: { token_access_type: 'offline' } }) } },
    { key: 'box', title: 'Box', category: 'Media', env: 'BOX', docs: 'https://app.box.com/developers/console', auth: { oauth2: g('https://account.box.com/api/oauth2/authorize', 'https://api.box.com/oauth2/token', '') } },
    { key: 'plex', title: 'Plex', category: 'Media', env: 'PLEX', docs: 'https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/', auth: { urlToken: true } },
    { key: 'lastfm', title: 'Last.fm', category: 'Media', env: 'LASTFM', docs: 'https://www.last.fm/api/account/create', auth: { apiKey: true } },
    { key: 'tmdb', title: 'TMDB', category: 'Media', env: 'TMDB', docs: 'https://www.themoviedb.org/settings/api', auth: { apiKey: true } },
    { key: 'openweather', title: 'OpenWeather', category: 'Data', env: 'OPENWEATHER', docs: 'https://home.openweathermap.org/api_keys', auth: { apiKey: true } },
    { key: 'mapbox', title: 'Mapbox', category: 'Data', env: 'MAPBOX', docs: 'https://account.mapbox.com/access-tokens/', auth: { token: true } },
    { key: 'home-assistant', title: 'Home Assistant', category: 'Home', env: 'HASS', docs: 'https://www.home-assistant.io/docs/authentication/#your-account-profile', auth: { urlToken: true } },
    { key: 'proxmox', title: 'Proxmox VE', category: 'Home', env: 'PROXMOX', docs: 'https://pve.proxmox.com/wiki/User_Management#pveum_tokens', auth: { urlToken: true }, note: 'Token as user@realm!tokenid=secret.' },
    { key: 'pihole', title: 'Pi-hole', category: 'Home', env: 'PIHOLE', docs: 'https://docs.pi-hole.net/', auth: { urlToken: true } },

    // Webhooks, bots, mail, databases, push
    { key: 'discord-webhook', title: 'Discord webhook', category: 'Communication', env: 'DISCORD', docs: 'https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks', auth: { webhook: true }, note: 'Channel settings → Integrations → Webhooks.' },
    { key: 'slack-webhook', title: 'Slack incoming webhook', category: 'Communication', env: 'SLACK', docs: 'https://api.slack.com/messaging/webhooks', auth: { webhook: true } },
    { key: 'telegram-bot', title: 'Telegram bot + chat', category: 'Communication', env: 'TELEGRAM', docs: 'https://core.telegram.org/bots#botfather', auth: { botChat: true }, note: 'Token from @BotFather; chat ID from @userinfobot or getUpdates.' },
    { key: 'smtp', title: 'SMTP (e-mail sending)', category: 'Communication', env: 'SMTP', docs: '', auth: { smtp: true } },
    { key: 'ntfy', title: 'ntfy push', category: 'Communication', env: 'NTFY', docs: 'https://docs.ntfy.sh/', auth: { urlTopic: true } },
    { key: 'gotify', title: 'Gotify', category: 'Communication', env: 'GOTIFY', docs: 'https://gotify.net/docs/', auth: { urlToken: true } },
    { key: 'postgres', title: 'PostgreSQL', category: 'Database', env: 'PG', docs: '', auth: { dbUrl: true }, note: 'Exports PG_URL; most libraries also accept DATABASE_URL — add a custom env name if needed.' },
    { key: 'mysql', title: 'MySQL / MariaDB', category: 'Database', env: 'MYSQL', docs: '', auth: { dbUrl: true } },
    { key: 'mongodb', title: 'MongoDB', category: 'Database', env: 'MONGODB', docs: '', auth: { dbUrl: true } },
    { key: 'redis', title: 'Redis', category: 'Database', env: 'REDIS', docs: '', auth: { dbUrl: true } },
    { key: 'ssh', title: 'SSH host', category: 'Developer', env: 'SSH', docs: '', auth: { sshKey: true, basic: true } },
    { key: 'generic-webhook', title: 'Webhook (any)', category: 'Custom', env: 'WEBHOOK', docs: '', auth: { webhook: true } },

    // Generic
    { key: 'custom', title: 'Custom service', category: 'Custom', env: 'CUSTOM', docs: '', auth: { apiKey: true, token: true, basic: true, header: true, webhook: true, dbUrl: true, clientPair: true, json: true, oauth2: { ...OAUTH2_GENERIC } }, note: 'Any service: pick an auth style, set your own environment prefix, or define OAuth2 URLs by hand (same fields as n8n\'s generic OAuth2).' },
];

export const byKey = Object.fromEntries(services.map(s => [s.key, s]));

export function fieldsFor(style) {
    const st = AUTH_STYLES[style];
    if (!st) throw Object.assign(new Error('Unknown auth style.'), { status: 400 });
    return st.fields;
}

// Public shape for the picker (no functions).
export function publicCatalog() {
    return services.map(s => ({
        key: s.key, title: s.title, category: s.category, env: s.env, docs: s.docs, note: s.note || '',
        styles: Object.keys(s.auth),
        oauth2: s.auth.oauth2 ? { authUrl: s.auth.oauth2.authUrl, tokenUrl: s.auth.oauth2.tokenUrl, scopes: s.auth.oauth2.scopes, pkce: !!s.auth.oauth2.pkce, clientAuth: s.auth.oauth2.clientAuth || 'body' } : null,
    }));
}
