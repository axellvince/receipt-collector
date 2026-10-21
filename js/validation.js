export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRIES = 10;
export const MAX_NOTES_LENGTH = 500;
export const RECEIPT_TYPES = Object.freeze(['handwritten', 'printed']);
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
const FILE_EXTENSIONS = Object.freeze({
  'image/jpeg': ['jpg', 'jpeg'], 'image/png': ['png'], 'image/webp': ['webp'], 'application/pdf': ['pdf'],
});

export function validateFile(file) {
  if (!file) return 'Pilih satu file nota terlebih dahulu.';
  if (!Object.hasOwn(MIME_EXTENSIONS, file.type)) return 'Format tidak didukung. Gunakan JPG, PNG, WEBP, atau PDF.';
  if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'File kosong atau tidak dapat dibaca. Pilih file lain.';
  if (file.size > MAX_FILE_BYTES) return 'Ukuran file melebihi 5 MB. Pilih file berukuran lebih kecil.';
  if (!file.name || file.name.length > 255) return 'Nama file asli terlalu panjang. Gunakan nama dengan maksimal 255 karakter.';
  if (/[\u0000-\u001f\u007f/\\]/.test(file.name)) return 'Nama file mengandung karakter yang tidak didukung. Ubah nama file, lalu pilih kembali.';
  const extension = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  if (!FILE_EXTENSIONS[file.type].includes(extension)) return 'Ekstensi file tidak sesuai dengan formatnya. Pilih file JPG, PNG, WEBP, atau PDF yang valid.';
  return '';
}

export function validateEntry(entry) {
  const errors = {};
  if (!RECEIPT_TYPES.includes(entry.receiptType)) errors.type = 'Pilih jenis nota.';
  if (!CATEGORIES.some(([value]) => value === entry.receiptCategory)) errors.category = 'Pilih kategori nota.';
  if (entry.receiptCategory === 'nota_lain_lain' && (entry.notes || '').length > MAX_NOTES_LENGTH) errors.notes = 'Keterangan maksimal 500 karakter.';
  if (entry.receiptCategory === 'nota_lain_lain' && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.notes || '')) errors.notes = 'Keterangan mengandung karakter yang tidak didukung.';
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
// The server remains the only source of the final sequence number and name.
export function isStoredResponse(result, payload) {
  if (!result || result.ok !== true || result.status !== 'stored' || result.entryId !== payload.entryId || result.submissionId !== payload.submissionId) return false;
  if (result.mimeType !== payload.mimeType || result.fileSize !== payload.fileSize || typeof result.replayed !== 'boolean') return false;
  const extension = MIME_EXTENSIONS[payload.mimeType];
  if (!extension || !RECEIPT_TYPES.includes(payload.receiptType) || !CATEGORIES.some(([value]) => value === payload.receiptCategory)) return false;
  const pattern = new RegExp(`^${payload.receiptType}-${payload.receiptCategory}[1-9][0-9]*\\.${extension}$`);
  return typeof result.savedFilename === 'string' && pattern.test(result.savedFilename);
}

export function formatFileSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

export function pendingEntries(entries) {
  return entries.filter(entry => entry.status !== 'success' && !(entry.status === 'error' && entry.retryable === false));
}
