export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRIES = 10;
export const MAX_NOTES_LENGTH = 500;
export const RECEIPT_TYPES = Object.freeze(['handwritten', 'printed', 'digital']);
export const CATEGORIES = Object.freeze([
  ['nota_belanja_sehari_hari', 'Nota belanja sehari-hari'],
  ['nota_tagihan_listrik', 'Nota tagihan listrik'],
  ['nota_tagihan_internet', 'Nota tagihan internet'],
  ['nota_tagihan_air', 'Nota tagihan air'],
  ['nota_pembelian_bensin', 'Nota pembelian bensin'],
  ['nota_pembelian_makanan', 'Nota pembelian makanan'],
  ['nota_pembayaran_gerbang_tol', 'Nota pembayaran gerbang tol'],
  ['nota_lain_lain', 'Nota lain-lain'],
]);
export const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
});

export function validateFile(file) {
  if (!file) return 'Pilih file nota terlebih dahulu.';
  if (!Object.hasOwn(MIME_EXTENSIONS, file.type)) return 'Format tidak didukung. Gunakan JPG, PNG, WEBP, atau PDF.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'File kosong atau tidak dapat dibaca. Pilih file lain.';
  if (file.size > MAX_FILE_BYTES) return 'Ukuran file melebihi 5 MB. Pilih file berukuran lebih kecil.';
  if (!file.name || file.name.length > 255) return 'Nama file asli terlalu panjang. Gunakan nama dengan maksimal 255 karakter.';
  if (/[\u0000-\u001f\u007f/\\]/.test(file.name)) return 'Nama file mengandung karakter yang tidak didukung. Ubah nama file, lalu pilih kembali.';
  return '';
}

export function validateEntry(entry) {
  const errors = {};
  const fileError = validateFile(entry.file);
  if (fileError) errors.file = fileError;
  return errors;
}

export function getUploadUrl(config) {
  if (!config || !config.workerUrl || !config.turnstileSiteKey) return null;
  try {
    const url = new URL(config.workerUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    if (!/^[A-Za-z0-9_-]{10,100}$/.test(config.turnstileSiteKey)) return null;
    return `${url.origin}/api/upload`;
  } catch { return null; }
}

// Strictly check the server acknowledgement before showing a success state.
// Original names and bytes must be confirmed by the server, never inferred.
export function isStoredResponse(result, payload) {
  if (!result || result.ok !== true || result.status !== 'stored' || result.entryId !== payload.entryId || result.submissionId !== payload.submissionId) return false;
  if (payload.schemaVersion !== 2 || payload.uploadMode !== 'original' || result.schemaVersion !== 2 || result.uploadMode !== 'original') return false;
  if (result.mimeType !== payload.mimeType || result.fileSize !== payload.fileSize || typeof result.replayed !== 'boolean') return false;
  return Object.hasOwn(MIME_EXTENSIONS, payload.mimeType) &&
    typeof result.savedFilename === 'string' && result.savedFilename === payload.originalFilename;
}

export function formatFileSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export function pendingEntries(entries) {
  return entries.filter(entry => entry.status !== 'success' && !(entry.status === 'error' && entry.retryable === false));
}
