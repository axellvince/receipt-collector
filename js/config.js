// Public configuration only. Never add the Apps Script URL, Drive folder ID,
// spreadsheet ID, shared secret, or Turnstile secret here.
export const APP_CONFIG = Object.freeze({
  // Example shape: https://receipt-collector.<your-subdomain>.workers.dev
  workerUrl: 'https://receipt-collector-api.axellvince.workers.dev',
  // Public site key from your Cloudflare Turnstile widget.
  turnstileSiteKey: '0x4AAAAAAFekzXZoJ1FTVEPp',
});
