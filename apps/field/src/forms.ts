// Custom forms for field records: a form is a list of fields (text, number, a choice, yes/no, a date or a
// scanned code). Forms come built in, or are made on the phone, pasted as JSON or scanned from a QR code.

export type FieldType = 'text' | 'number' | 'choice' | 'yesno' | 'date' | 'code';
export interface Field {
  key: string;
  label: string;
  type: FieldType;
  options?: string[];
  required?: boolean;
  min?: number;
  max?: number;
  unit?: string;
}
export interface Form { name: string; fields: Field[] }
export type Value = string | number | boolean | null;
export type Values = Record<string, Value>;

export const TYPES: FieldType[] = ['text', 'number', 'choice', 'yesno', 'date', 'code'];
export const TYPE_LABEL: Record<FieldType, string> = { text: 'Text', number: 'Number', choice: 'Choice', yesno: 'Yes or no', date: 'Date', code: 'QR or barcode' };

export const BUILT_IN: Form[] = [
  {
    name: 'Garden survey',
    fields: [
      { key: 'crop', label: 'Main crop', type: 'choice', options: ['Kaukau', 'Taro', 'Banana', 'Yam', 'Cassava', 'Coffee', 'Cocoa', 'Mixed', 'Fallow'], required: true },
      { key: 'owner', label: 'Clan or owner', type: 'text' },
      { key: 'stage', label: 'Stage', type: 'choice', options: ['New', 'Growing', 'Harvesting', 'Old'] },
      { key: 'fenced', label: 'Fenced', type: 'yesno' },
      { key: 'planted', label: 'Planted', type: 'date' },
    ],
  },
  {
    name: 'Tree plot',
    fields: [
      { key: 'tag', label: 'Tree tag', type: 'code' },
      { key: 'species', label: 'Species', type: 'text', required: true },
      { key: 'dbh_cm', label: 'Diameter at breast height', type: 'number', unit: 'cm', min: 1, max: 500, required: true },
      { key: 'height_m', label: 'Height', type: 'number', unit: 'm', min: 0, max: 90 },
      { key: 'condition', label: 'Condition', type: 'choice', options: ['Good', 'Damaged', 'Dying', 'Dead'] },
    ],
  },
];

/** A safe property key from a label: "Tree tag" becomes "tree_tag". */
export function keyOf(label: string): string {
  const k = label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return (/^[0-9]/.test(k) ? `f_${k}` : k) || 'field';
}

/** Checks and tidies a form from JSON (pasted or scanned); throws with a plain message when it is not one. */
export function parseForm(input: string | unknown): Form {
  let o: unknown = input;
  if (typeof input === 'string') {
    try { o = JSON.parse(input); } catch { throw new Error('That is not a form (it is not JSON).'); }
  }
  const f = o as { name?: unknown; fields?: unknown };
  if (!f || typeof f !== 'object' || typeof f.name !== 'string' || !f.name.trim()) throw new Error('A form needs a name.');
  if (!Array.isArray(f.fields) || !f.fields.length) throw new Error('A form needs at least one field.');
  if (f.fields.length > 60) throw new Error('A form can have at most 60 fields.');
  const seen = new Set<string>();
  const fields = f.fields.map((x, i): Field => {
    const d = x as Partial<Field>;
    const label = typeof d.label === 'string' && d.label.trim() ? d.label.trim().slice(0, 80) : '';
    if (!label) throw new Error(`Field ${i + 1} needs a label.`);
    const type = (d.type ?? 'text') as FieldType;
    if (!TYPES.includes(type)) throw new Error(`"${label}" has an unknown type (${String(d.type)}).`);
    let key = keyOf(typeof d.key === 'string' && d.key.trim() ? d.key : label);
    while (seen.has(key)) key += '_2';
    seen.add(key);
    const out: Field = { key, label, type };
    if (type === 'choice') {
      const opts = Array.isArray(d.options) ? [...new Set(d.options.map((s) => String(s).trim()).filter(Boolean))] : [];
      if (!opts.length) throw new Error(`"${label}" needs some choices.`);
      out.options = opts;
    }
    if (d.required) out.required = true;
    if (type === 'number') {
      if (typeof d.min === 'number' && Number.isFinite(d.min)) out.min = d.min;
      if (typeof d.max === 'number' && Number.isFinite(d.max)) out.max = d.max;
      if (typeof d.unit === 'string' && d.unit.trim()) out.unit = d.unit.trim().slice(0, 12);
    }
    return out;
  });
  return { name: f.name.trim().slice(0, 60), fields };
}

/** Problems with the values for a form, one plain sentence each (none when they can be saved). */
export function check(form: Form, v: Values): string[] {
  const out: string[] = [];
  for (const f of form.fields) {
    const x = v[f.key];
    const empty = x == null || x === '';
    if (empty) { if (f.required) out.push(`${f.label} is needed.`); continue; }
    if (f.type === 'number') {
      if (typeof x !== 'number' || !Number.isFinite(x)) out.push(`${f.label} must be a number.`);
      else if (f.min != null && x < f.min) out.push(`${f.label} must be at least ${f.min}${f.unit ? ` ${f.unit}` : ''}.`);
      else if (f.max != null && x > f.max) out.push(`${f.label} must be at most ${f.max}${f.unit ? ` ${f.unit}` : ''}.`);
    }
    if (f.type === 'choice' && !f.options!.includes(String(x))) out.push(`${f.label} must be one of the choices.`);
    if (f.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(x))) out.push(`${f.label} must be a date.`);
  }
  return out;
}

/** Turns what was typed into values: numbers become numbers, yes/no becomes true or false, blanks become null. */
export function coerce(form: Form, raw: Record<string, string>): Values {
  const v: Values = {};
  for (const f of form.fields) {
    const s = (raw[f.key] ?? '').trim();
    if (s === '') v[f.key] = null;
    else if (f.type === 'number') v[f.key] = Number(s.replace(',', '.'));
    else if (f.type === 'yesno') v[f.key] = s === 'yes' ? true : s === 'no' ? false : null;
    else v[f.key] = s;
  }
  return v;
}

/** A short line for the record list: "Kaukau · Fenced: yes". */
export function summary(form: Form | undefined, v: Values | undefined, max = 3): string {
  if (!v) return '';
  const parts: string[] = [];
  for (const f of form?.fields ?? Object.keys(v).map((key) => ({ key, label: key, type: 'text' as FieldType }))) {
    const x = v[f.key];
    if (x == null || x === '') continue;
    const s = typeof x === 'boolean' ? (x ? 'yes' : 'no') : `${x}${'unit' in f && f.unit ? ` ${f.unit}` : ''}`;
    parts.push(f.type === 'choice' || f.type === 'text' ? s : `${f.label}: ${s}`);
    if (parts.length >= max) break;
  }
  return parts.join(' · ');
}

/** What a QR code holds: a form, a phone link, a coordinate or just a code. */
export function qrKind(s: string): 'form' | 'link' | 'code' {
  const t = s.trim();
  if (t.startsWith('{') && /"fields"\s*:/.test(t)) return 'form';
  if (/^https?:\/\/.+#t=/.test(t)) return 'link';
  return 'code';
}
