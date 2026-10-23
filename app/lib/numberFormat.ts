// Cache formatters, never prices: every render still formats the current value.
// Bounded per runtime so user-selected precision cannot grow memory indefinitely.
const formats = new Map<string, Intl.NumberFormat>();
const MAX_FORMATS = 32;

export function decimalNumber(value: number, maximumFractionDigits = 3, minimumFractionDigits = 0): string {
  const key = `${minimumFractionDigits}:${maximumFractionDigits}`;
  let format = formats.get(key);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { minimumFractionDigits, maximumFractionDigits });
    if (formats.size >= MAX_FORMATS) formats.delete(formats.keys().next().value!);
    formats.set(key, format);
  }
  return format.format(value);
}
