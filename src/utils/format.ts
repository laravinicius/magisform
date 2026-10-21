// Formata em tempo de digitação: DDD entre parênteses após 2 dígitos,
// aceita fixo (00) 0000-0000 (10 dígitos) ou celular (00) 00000-0000 (11 dígitos)
export function formatPhone(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length === 0) return '';
  if (digits.length <= 2) return `(${digits}`;
  const ddd = digits.slice(0, 2);
  const rest = digits.slice(2);
  if (digits.length === 10) return `(${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
  if (rest.length <= 5) return `(${ddd}) ${rest}`;
  return `(${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
}

export function isValidPhone(value: string): boolean {
  return value.replace(/\D/g, '').length === 11;
}

// Formata moeda com dígitos na parte inteira e mantém os centavos após a vírgula.
export function formatCurrency(value: string): string {
  const normalized = value.replace(/[^\d,]/g, '');
  if (!normalized) return '';
  const commaIndex = normalized.lastIndexOf(',');
  const rawReais = commaIndex >= 0 ? normalized.slice(0, commaIndex).replace(/,/g, '') : normalized;
  const rawCents = commaIndex >= 0 ? normalized.slice(commaIndex + 1) : '';
  const reais = (rawReais.slice(0, 13).replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${reais},${rawCents.slice(0, 2).padEnd(2, '0')}`;
}

// Converte texto com máscara de moeda para número (ex.: "1.234,56" → 1234.56).
// Sem vírgula, os dígitos representam reais inteiros.
export function parseCurrency(value: string): number {
  const normalized = value.replace(/[^\d,]/g, '');
  if (!normalized) return 0;
  const commaIndex = normalized.lastIndexOf(',');
  const reais = commaIndex >= 0 ? normalized.slice(0, commaIndex).replace(/,/g, '') : normalized;
  const cents = commaIndex >= 0 ? normalized.slice(commaIndex + 1) : '';
  return Number(reais || 0) + Number(cents.padEnd(2, '0').slice(0, 2) || 0) / 100;
}

// Calcula a posição equivalente do cursor após aplicar a máscara monetária.
export function currencyCaretPosition(value: string, selectionStart: number): number {
  const commaIndex = value.indexOf(',');
  const [integerPart, centsPart = ''] = value.split(',', 2);
  const formattedInteger = (integerPart.replace(/\D/g, '').replace(/^0+(?=\d)/, '') || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (commaIndex >= 0 && selectionStart > commaIndex) {
    const centsBeforeCaret = value.slice(commaIndex + 1, selectionStart).replace(/\D/g, '').length;
    return formattedInteger.length + 1 + Math.min(centsBeforeCaret, centsPart.length);
  }
  const digitsBeforeCaret = value.slice(0, selectionStart).replace(/\D/g, '').length;
  if (!digitsBeforeCaret) return 0;
  let seen = 0;
  for (let i = 0; i < formattedInteger.length; i++) {
    if (/\d/.test(formattedInteger[i])) seen++;
    if (seen === digitsBeforeCaret) return i + 1;
  }
  return formattedInteger.length;
}

// Máscara de data ao digitar (ex.: "15082026" → "15/08/2026")
export function formatDateBR(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 8);
  if (!digits) return '';
  if (digits.length <= 2) return digits;
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`;
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
}

// Converte "DD/MM/AAAA" (ou "ddmmaaaa") para ISO "AAAA-MM-DD";
// valida data real (dias do mês e ano bissexto). Retorna null se inválida.
export function parseDateBR(value: string): string | null {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 8) return null;
  const dd = Number(digits.slice(0, 2));
  const mm = Number(digits.slice(2, 4));
  const yyyy = Number(digits.slice(4));
  if (mm < 1 || mm > 12 || dd < 1) return null;
  const daysInMonth = new Date(yyyy, mm, 0).getDate();
  if (dd > daysInMonth) return null;
  return `${String(yyyy).padStart(4, '0')}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

// Converte ISO "AAAA-MM-DD" para exibição "DD/MM/AAAA"
export function formatDateToBR(iso: string): string {
  const [y, m, d] = iso.split('-');
  return d && m && y ? `${d}/${m}/${y}` : iso;
}

// Remove acentos para comparação na busca (ex.: "jose" encontra "José")
export function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Padroniza a exibição da unidade sem alterar o valor persistido.
export function formatUnit(unit: string): string {
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit === 'caps s.l.') return 'caps S.L.';
  if (normalizedUnit === 'sachê') return 'sachês';
  return unit;
}

// Formata quantidade: remove zeros à direita; usa . para milhar, , para decimal
// ex.: 2 → "2", 2.5 → "2,5", 2.500 → "2,5", 1234.5 → "1.234,5", 1000000 → "1.000.000"
export function formatQuantity(value: number | string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  if (Number.isInteger(n)) return n.toLocaleString('pt-BR');
  const str = n.toString();
  const decimals = str.split('.')[1]?.replace(/0+$/, '') ?? '';
  return decimals
    ? n.toLocaleString('pt-BR', { minimumFractionDigits: decimals.length, maximumFractionDigits: decimals.length })
    : n.toLocaleString('pt-BR');
}

// Máscara de quantidade ao digitar: aceita até 6 dígitos, insere separador de milhar (.)
// ex.: "123456" → "123.456", "1234" → "1.234", "12" → "12"
export function formatQuantityInput(value: string): string {
  const digits = value.replace(/\D/g, '').slice(0, 6);
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Converte quantidade com máscara de volta para número
// ex.: "123.456" → 123456, "1.234" → 1234
export function parseQuantity(value: string): number {
  const digits = value.replace(/\D/g, '');
  return digits ? Number(digits) : 0;
}
