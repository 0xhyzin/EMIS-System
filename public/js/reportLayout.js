export const DEFAULT_SIGNATURE_LABELS = ['إحصاء', 'شؤون العاملين', 'مدير المدرسة'];

// Keep previously saved templates compatible with editable titles and names.
export function normalizeSignatures(footer) {
  const values = Array.isArray(footer) ? footer : [footer?.stats || '', footer?.review || '', footer?.principal || ''];
  return values.slice(0, 9).map((value, index) => value && typeof value === 'object'
    ? { label: String(value.label || 'توقيع').trim(), name: String(value.name ?? '').trim() }
    : { label: DEFAULT_SIGNATURE_LABELS[index] || 'توقيع إضافي', name: String(value ?? '').trim() });
}
